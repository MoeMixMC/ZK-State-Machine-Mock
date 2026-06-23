(function () {
  "use strict";

  const ORDER_STATUSES = [
    "CREATED",
    "SIGNAL_OPTIONS_CREATED",
    "SIGNALING_INTENT",
    "INTENT_SIGNALED",
    "BUYER_TEE_INPUT_RECEIVED",
    "ATTESTATION_REQUESTED",
    "ATTESTATION_SIGNED",
    "FULFILL_OPTIONS_CREATED",
    "FULFILLING_INTENT",
    "FULFILLED",
    "EXPIRED",
    "FAILED",
  ];

  const MAKER_DEPOSIT_STATUSES = ["pending", "active", "paused", "empty", "failed"];
  const PENDING_DEPOSIT_STATUSES = ["submitted", "confirmed", "failed"];
  const DEPOSIT_SUBMISSION_STATUSES = ["SUBMITTED", "CONFIRMED", "FAILED"];
  const ALLOWED_ACTIONS = [
    "signal",
    "open_payment",
    "submit_buyer_tee",
    "retry_buyer_tee",
    "fulfill",
  ];
  const JOB_TYPES = [
    "deposit_reconcile",
    "signal_reconcile",
    "buyer_tee_attestation",
    "fulfill_reconcile",
    "intent_expiry_reconcile",
  ];
  const JOB_PHASES = ["deposit", "signal", "buyer_tee", "fulfill", "expiry"];
  const JOB_STATUSES = ["queued", "running", "succeeded", "dead"];
  const LIFECYCLE_EVENT_TYPES = [
    "ORDER_CREATED",
    "ORDER_ADVANCE_ERROR",
    "SIGNAL_SUBMITTED",
    "BUYER_TEE_SUBMITTED",
    "FULFILL_SUBMITTED",
    "ZKP2P_JOB_CLAIMED",
    "ZKP2P_JOB_SUCCEEDED",
    "ZKP2P_JOB_RETRYABLE_FAILURE",
    "ZKP2P_JOB_DEAD",
  ];
  const CHAIN_INTENT_STATES = ["active", "expired", "pruned", "unknown", "none"];

  const ACTION_EXPLANATIONS = {
    "Create quote + order": {
      phase: "order",
      app: "The app has enough send intent to ask the backend for a quote: sender, receiver, amount, rail, and available maker liquidity.",
      backend:
        "The backend creates a zkp2p_orders row in CREATED, stores the signalIntent parameters it will later encode, and returns an order view with allowedActions containing signal.",
      why:
        "This is only a local/order step. No maker liquidity is reserved until signalIntent lands on-chain, so the payment UI should not be treated as final yet.",
    },
    "Prepare signal options": {
      phase: "signal",
      app: "The app asks for signing/UserOperation options so the sender can authorize the signalIntent call with their wallet or passkey.",
      backend:
        "The backend builds the signalIntent calldata and gas/UserOperation options, but does not mark the intent as reserved yet.",
      why:
        "Preparation gives the client something to sign. It must stay separate from submission because a prepared UserOperation can still be abandoned.",
    },
    "Submit signalIntent": {
      phase: "signal",
      app: "The app submits the signed signalIntent UserOperation returned by the wallet/passkey flow.",
      backend:
        "The backend sends the UserOperation to the bundler, stores signalUserOpHash, moves the order to SIGNALING_INTENT, emits SIGNAL_SUBMITTED, and queues signal_reconcile.",
      why:
        "The order is pending because the chain has not been indexed yet. Buyer payment should stay locked behind reconciliation so users do not pay before maker liquidity is actually reserved.",
    },
    "Signal receipt pending": {
      phase: "signal",
      app: "The app polls or refreshes the order while signalIntent is still pending.",
      backend:
        "The signal_reconcile job tries to fetch the UserOperation receipt, cannot find it yet, records a retryable failure, and leaves the order in SIGNALING_INTENT.",
      why:
        "This is a normal asynchronous chain gap. The system should wait and retry instead of flipping buttons based on optimism.",
    },
    "Signal success": {
      phase: "signal",
      app: "The app receives an updated order view after the backend confirms the signalIntent succeeded.",
      backend:
        "The backend reads the UserOperation receipt, fetches the transaction receipt, decodes IntentSignaled, stores intentHash, timestamp, and tx hash, marks INTENT_SIGNALED, increments outstanding liquidity, and queues expiry reconciliation.",
      why:
        "This is the handoff from on-chain reservation to off-chain payment. The buyer can now pay and verify because the maker deposit has a specific active intent.",
    },
    "Signal failure": {
      phase: "signal",
      app: "The app learns that the reservation failed and should stop the send flow.",
      backend:
        "The backend confirms the signal UserOperation failed, marks FAILED, and records the failure reason.",
      why:
        "No fiat payment should happen. The maker liquidity was never safely reserved for this sender.",
    },
    "Open Cash App flow": {
      phase: "payment",
      app: "The app opens the Cash App deep link or web flow using the stored human payment instructions.",
      backend:
        "The backend does not release anything from this click. In this mock, the payment is marked as done only so the next verification step is easier to see.",
      why:
        "Fiat payment is outside the chain. The system still needs Buyer TEE verification before fulfillIntent can release USDC.",
    },
    "Submit Buyer TEE input": {
      phase: "buyer_tee",
      app: "The app submits the buyer's encrypted payment verification input after the payment flow or a manual 'I completed payment' path.",
      backend:
        "The backend stores the Buyer TEE input, marks BUYER_TEE_INPUT_RECEIVED, emits BUYER_TEE_SUBMITTED, and queues buyer_tee_attestation.",
      why:
        "The order is intentionally waiting here. Buttons should be disabled while the attestation job is queued or running, and retry should appear only if that job dies.",
    },
    "Show ATTESTATION_REQUESTED": {
      phase: "buyer_tee",
      app: "The app is showing a legacy/intermediate state for teaching purposes.",
      backend:
        "Older flows had an ATTESTATION_REQUESTED style phase. The newer Buyer TEE flow mostly moves from BUYER_TEE_INPUT_RECEIVED to ATTESTATION_SIGNED after the service responds.",
      why:
        "Keeping this visible helps you recognize old status names, but production UI should normally follow allowedActions instead of hard-coded status guesses.",
    },
    "Buyer TEE success": {
      phase: "buyer_tee",
      app: "The app receives an order refresh showing that payment verification succeeded.",
      backend:
        "The buyer_tee_attestation job succeeds. The backend stores the signed attestation/payment proof data and marks the order ATTESTATION_SIGNED.",
      why:
        "The signed attestation is the bridge from off-chain Cash App payment to on-chain release. fulfillIntent can now be prepared.",
    },
    "Buyer TEE retryable fail": {
      phase: "buyer_tee",
      app: "The app keeps the user in a waiting/retry posture instead of pretending the send is done.",
      backend:
        "The buyer_tee_attestation job records a retryable failure and returns to queued, keeping the order in BUYER_TEE_INPUT_RECEIVED.",
      why:
        "Temporary service errors should not strand the order or expose fulfill. A later worker/read retry can still complete verification.",
    },
    "Buyer TEE dead": {
      phase: "buyer_tee",
      app: "The app should now show a retry verification action because the current attestation job is dead.",
      backend:
        "The job reaches dead and records ZKP2P_JOB_DEAD. computeOrderViewState exposes retry_buyer_tee without changing the raw order status.",
      why:
        "This is the clean retry pattern: keep the truthful status, surface a backend-owned allowed action, and avoid mobile guessing.",
    },
    "Prepare fulfill options": {
      phase: "fulfill",
      app: "The app asks for signing/UserOperation options to release the verified intent to the receiver.",
      backend:
        "The backend builds fulfillIntent calldata using the order's intentHash and signed attestation, but it has not submitted the release yet.",
      why:
        "Only an ATTESTATION_SIGNED order can safely reach this step. The proof material is what makes the contract release the maker's escrowed USDC.",
    },
    "Submit fulfillIntent": {
      phase: "fulfill",
      app: "The app submits the signed fulfillIntent UserOperation.",
      backend:
        "The backend sends the UserOperation, stores fulfillUserOpHash, marks FULFILLING_INTENT, emits FULFILL_SUBMITTED, and queues fulfill_reconcile.",
      why:
        "The receiver should not see a completed send until the chain receipt confirms the release.",
    },
    "Fulfill success": {
      phase: "fulfill",
      app: "The app refreshes to a completed send.",
      backend:
        "The backend decodes IntentFulfilled, stores fulfillTxHash, marks FULFILLED, clears the active chain intent, decrements outstanding and remaining liquidity, and records the user-facing transfer.",
      why:
        "This is the final settlement point: the receiver's UPay balance/activity can now show the Cash App-funded USDC transfer.",
    },
    "Fulfill failure": {
      phase: "fulfill",
      app: "The app sees that release failed and should route this to support/manual review.",
      backend:
        "The backend confirms the fulfill UserOperation failed, marks FAILED, and leaves enough hashes/status information for debugging.",
      why:
        "This is the scary failure mode because fiat may already have moved. Automation should stop and support should inspect before retrying or compensating.",
    },
    "Expire intent": {
      phase: "expiry",
      app: "The app refreshes an old in-progress order and learns the intent is past its valid payment window.",
      backend:
        "The backend marks the order EXPIRED and represents the chain intent as expired, but the reservation may still need pruning.",
      why:
        "Expired is terminal for the buyer UX, but maker liquidity may remain outstanding until pruneExpiredIntents succeeds.",
    },
    "Prune success": {
      phase: "expiry",
      app: "The app no longer needs to show this as an actionable send.",
      backend:
        "The expiry job succeeds, stores a prune tx hash, marks the chain intent pruned, and decrements outstanding maker liquidity once.",
      why:
        "This prevents a dead/expired send from keeping liquidity reserved forever in local availability calculations.",
    },
    "Prune failure": {
      phase: "expiry",
      app: "The app should still treat the buyer order as expired, but support/debug views should show the cleanup problem.",
      backend:
        "The expiry job records a retryable failure because pruneExpiredIntents could not be submitted or confirmed.",
      why:
        "This separates buyer terminal state from maker liquidity cleanup. The worker can retry without reopening buyer actions.",
    },
    "Repair expired still active": {
      phase: "expiry",
      app: "The app sees an order return to a payable state after backend reconciliation discovers local state was too pessimistic.",
      backend:
        "The backend compares local EXPIRED against the chain summary, sees the intent is still active, and repairs the status back to INTENT_SIGNALED.",
      why:
        "This protects against local clock or stale-read mistakes. Chain truth wins when deciding whether payment can still proceed.",
    },
    "Register Cash App payee": {
      phase: "deposit",
      app: "The maker enters the Cash App handle they want buyers to pay.",
      backend:
        "The backend would normalize the handle, store encrypted payee details, and store/hash the payee in the format expected by ZKP2P matching.",
      why:
        "A deposit is only useful if buyers can get human payment instructions while contracts/verifiers still use protocol-safe hashes.",
    },
    "Prepare deposit options": {
      phase: "deposit",
      app: "The maker asks the backend for the createDeposit signing/UserOperation options.",
      backend:
        "The backend builds createDeposit calldata for the maker's escrow amount, payee hash, gating signer, verifier settings, and AA gas options.",
      why:
        "This creates the object the maker signs. Nothing is active until the UserOperation confirms.",
    },
    "Submit createDeposit": {
      phase: "deposit",
      app: "The maker submits the signed createDeposit UserOperation.",
      backend:
        "The backend stores a pending deposit submission, creates a pending local maker deposit, and queues deposit_reconcile.",
      why:
        "Liquidity should not be shown as active until the on-chain deposit id is decoded from the confirmed transaction.",
    },
    "Deposit receipt pending": {
      phase: "deposit",
      app: "The maker screen keeps showing the deposit as pending.",
      backend:
        "The deposit_reconcile job cannot find a receipt yet, records a retryable failure, and leaves the pending deposit unchanged.",
      why:
        "This is the deposit equivalent of signal pending: wait for chain confirmation before listing liquidity.",
    },
    "Deposit success": {
      phase: "deposit",
      app: "The maker now sees active cash-out liquidity.",
      backend:
        "The backend decodes the created deposit, stores the confirmed deposit id and tx hash, marks the submission CONFIRMED, and indexes the maker deposit as active.",
      why:
        "Senders can now reserve this liquidity. This is the handoff from maker cash-out setup into the UPay send matching flow.",
    },
    "Deposit failure": {
      phase: "deposit",
      app: "The maker sees that the cash-out deposit failed.",
      backend:
        "The backend marks the pending deposit, submission, and local maker deposit failed with a reason.",
      why:
        "Failed liquidity must not be selectable for senders, otherwise send flows would break at signalIntent.",
    },
    "Pause maker deposit": {
      phase: "deposit",
      app: "The maker disables new use of their active liquidity.",
      backend:
        "The local/indexed maker deposit status changes to paused. Existing outstanding intents are still tracked separately.",
      why:
        "Pause is an availability control. It should stop new matching without losing accounting for already signaled intents.",
    },
    "Resume maker deposit": {
      phase: "deposit",
      app: "The maker reopens their deposit for matching.",
      backend:
        "The local/indexed maker deposit status returns to active.",
      why:
        "Senders can use the remaining, non-outstanding liquidity again.",
    },
    "Mark empty": {
      phase: "deposit",
      app: "The maker/deposit view simulates a deposit with no usable liquidity left.",
      backend:
        "The indexed maker deposit is marked empty and remaining/outstanding amounts are zeroed in the mock.",
      why:
        "Empty deposits should be hidden from matching so senders do not reserve impossible liquidity.",
    },
    "Use this liquidity in Send tab": {
      phase: "order",
      app: "The demo switches to the send flow and creates an order using the active maker deposit.",
      backend:
        "The backend would select this indexed active deposit during quote/order creation and embed its deposit id into signalIntent params.",
      why:
        "This demonstrates the connection between maker cash-out liquidity and a sender's peer-to-peer UPay send.",
    },
    "UPay Send tab": {
      phase: "navigation",
      app: "The app switches to the sender flow screen.",
      backend:
        "No backend state changes. This is only a view change in the simulator.",
      why:
        "The same backend state can be inspected from different product surfaces.",
    },
    "Maker Cash Out tab": {
      phase: "navigation",
      app: "The app switches to the maker cash-out flow screen.",
      backend:
        "No backend state changes. This is only a view change in the simulator.",
      why:
        "Maker deposit state is separate from order state, but send matching depends on it.",
    },
    "Catalog tab": {
      phase: "navigation",
      app: "The app switches to the vocabulary catalog.",
      backend:
        "No backend state changes. This tab only lists the lifecycle vocabulary represented by the mock.",
      why:
        "Debugging gets easier when raw statuses, jobs, phases, and events have one visible glossary.",
    },
    "Concepts tab": {
      phase: "navigation",
      app: "The app switches to the conceptual map of the system.",
      backend:
        "No backend state changes. This tab explains what each entity is made of and how its fields drive the next phase.",
      why:
        "This is the translation layer between raw status words and the actual objects moving through app, backend, jobs, and contracts.",
    },
    "Reset demo": {
      phase: "demo",
      app: "The simulator clears local mock state.",
      backend:
        "No real backend state exists here. In production, reset would never delete orders or deposits this way.",
      why:
        "This lets you replay happy paths and failure paths from a clean slate.",
    },
  };

  const CONCEPT_GROUPS = [
    {
      title: "People, Money, And Payment Instructions",
      concepts: [
        {
          name: "Sender",
          summary:
            "The UPay user who wants to send USDC value without already holding a UPay balance. They pay the maker off-chain and receive on-chain release to the receiver.",
          note:
            "In the send flow, the sender is the actor who signs signalIntent and fulfillIntent through their smart account.",
          fields: [
            ["senderAddress", "Smart account or EOA address used as the caller for signal/fulfill UserOperations."],
            ["senderUserId / username", "Product identity used by the app for auth, history, and support views."],
            ["passkey/session", "Client-side authorization material used to sign UserOperations; never belongs in debug output."],
            ["fiat payment account", "The Cash App account that actually sends fiat to the maker. It is verified by Buyer TEE, not by the contract directly."],
          ],
        },
        {
          name: "Receiver",
          summary:
            "The UPay account that should receive USDC when the sender's fiat payment is verified.",
          fields: [
            ["recipientAddress", "Destination address encoded into signalIntent and used by fulfillIntent release."],
            ["recipientUsername", "Human UPay handle shown in UI and used for activity/history context."],
            ["expectedAmount", "The USDC amount the receiver should gain when fulfillIntent succeeds."],
            ["activity row", "Local stablecoin_transfers entry created after fulfill reconciliation so the receiver sees the send in history."],
          ],
        },
        {
          name: "Maker",
          summary:
            "The UPay user who is cashing out. They escrow USDC and receive Cash App payment from a sender.",
          fields: [
            ["makerAddress", "Owner of the escrowed USDC deposit."],
            ["payee", "Human payment destination such as a Cash App cashtag."],
            ["depositId", "On-chain identifier of the maker's escrow deposit."],
            ["remaining / outstanding", "Liquidity accounting used to decide whether senders can reserve this maker's deposit."],
          ],
        },
        {
          name: "Payment Rail",
          summary:
            "The off-chain money network used for maker payment, for example Cash App.",
          fields: [
            ["platform", "Rail identifier such as cashapp; controls normalization, deep link behavior, and verifier selection."],
            ["payee", "Human destination shown to the sender, e.g. $maab161151 for Cash App."],
            ["payeeHash", "Protocol-safe hash used by ZKP2P matching/verifiers so contracts do not store human payment text."],
            ["encryptedPayee", "Backend-only encrypted human payment details. It should not leak into debug snapshots."],
          ],
        },
        {
          name: "Payment Instructions",
          summary:
            "The user-facing directions for paying the maker after liquidity is reserved.",
          fields: [
            ["platform", "Tells mobile which payment flow/deep link to use."],
            ["payee", "Human handle displayed in banners and payment screens."],
            ["amount", "Fiat amount the sender must pay."],
            ["memo / reference", "Optional text used to help verification or support match the payment."],
          ],
        },
        {
          name: "Quote",
          summary:
            "A temporary match between sender amount and maker liquidity before an order exists.",
          fields: [
            ["tokenAmount", "USDC amount the receiver should get."],
            ["fiatAmount", "Off-chain amount the sender must pay the maker."],
            ["makerDeposit", "Selected active deposit with enough non-outstanding liquidity."],
            ["rate", "UPay's product rate; in this simulator it is always 1:1."],
          ],
        },
      ],
    },
    {
      title: "Core Backend Records",
      concepts: [
        {
          name: "Order",
          summary:
            "The central backend record for one UPay send. It ties the sender, receiver, maker deposit, off-chain payment, chain intent, attestation, and final release together.",
          fields: [
            ["id / orderId", "Stable local identifier used by mobile polling, jobs, events, and support snapshots."],
            ["status", "Raw lifecycle status such as CREATED, INTENT_SIGNALED, ATTESTATION_SIGNED, FULFILLED, EXPIRED, or FAILED."],
            ["senderAddress", "Caller/signer used for UserOperation authorization."],
            ["recipientAddress", "USDC release destination encoded into signalIntent."],
            ["makerAddress", "Owner of the selected liquidity deposit."],
            ["fiatAmount / tokenAmount", "Product amount and atomic USDC amount used for payment instructions and contract calls."],
            ["paymentInstructions", "Human rail/payee/amount shown after liquidity is reserved."],
            ["signalIntentParams", "Stored contract parameters used to build signalIntent calldata."],
            ["intentHash", "On-chain reservation id decoded from IntentSignaled and required for Buyer TEE and fulfill."],
            ["intentTimestampSeconds", "On-chain signal timestamp used to judge expiry."],
            ["paymentProof / verificationData", "Attestation output used by fulfillIntent; sensitive and not shown in debug UI."],
            ["signalUserOpHash / fulfillUserOpHash", "Bundler hashes used by reconciliation jobs to fetch UserOperation receipts."],
            ["signalTxHash / fulfillTxHash", "Chain transactions decoded after UserOperation success."],
            ["failureReason", "Human/debug message used when terminal FAILED is reached."],
          ],
        },
        {
          name: "Order Status",
          summary:
            "The raw backend state string. It is useful for storage and debugging, but mobile should prefer allowedActions for buttons.",
          fields: [
            ["CREATED", "Order exists locally; sender can reserve liquidity."],
            ["SIGNAL_OPTIONS_CREATED", "Mock teaching state for prepared signal options before submission."],
            ["SIGNALING_INTENT", "signalIntent UserOperation submitted; waiting for chain receipt."],
            ["INTENT_SIGNALED", "Chain reservation exists; sender may pay and verify."],
            ["BUYER_TEE_INPUT_RECEIVED", "Backend has encrypted buyer verification input; attestation job should run."],
            ["ATTESTATION_REQUESTED", "Legacy/intermediate teaching state for attestation request in progress."],
            ["ATTESTATION_SIGNED", "Payment verified; fulfillIntent can release USDC."],
            ["FULFILL_OPTIONS_CREATED", "Mock teaching state for prepared fulfill options before submission."],
            ["FULFILLING_INTENT", "fulfillIntent UserOperation submitted; waiting for final receipt."],
            ["FULFILLED", "Terminal success; receiver can see settled USDC activity."],
            ["EXPIRED", "Terminal buyer state; active reservation aged out and should be pruned if needed."],
            ["FAILED", "Terminal failure; support/manual review may be needed."],
          ],
        },
        {
          name: "Order View DTO",
          summary:
            "The backend's response shape for mobile. It combines raw order data with backend-owned UI decisions.",
          fields: [
            ["status", "Raw lifecycle status for display/debugging."],
            ["allowedActions", "Backend-owned list of actions mobile may expose: signal, open_payment, submit_buyer_tee, retry_buyer_tee, fulfill."],
            ["terminal", "Boolean used by mobile to stop polling and clear pending banners."],
            ["statusReason", "Human explanation of the current state."],
            ["lastFailure", "Structured retry/support hint with phase, message, and retryable flag."],
            ["txHash", "Latest relevant transaction hash for support/debug links."],
          ],
        },
        {
          name: "Allowed Action",
          summary:
            "A safe UI permission emitted by the backend. Mobile should not infer this from raw statuses alone.",
          fields: [
            ["signal", "Show reserve-liquidity action while CREATED."],
            ["open_payment", "Show payment flow once INTENT_SIGNALED."],
            ["submit_buyer_tee", "Allow verification submission once payment can be made."],
            ["retry_buyer_tee", "Allow retry when BUYER_TEE_INPUT_RECEIVED has a dead/missing attestation job."],
            ["fulfill", "Allow release only when ATTESTATION_SIGNED."],
          ],
        },
        {
          name: "Maker Deposit",
          summary:
            "The indexed local view of a maker's on-chain escrowed liquidity.",
          fields: [
            ["id", "Local compound key, often escrow address plus deposit id."],
            ["depositId", "On-chain deposit identifier decoded from createDeposit."],
            ["status", "pending, active, paused, empty, or failed."],
            ["remainingAmount", "USDC still available after fulfilled sends."],
            ["outstandingAmount", "USDC reserved by active intents but not yet fulfilled or pruned."],
            ["acceptingIntents", "Whether matching should consider the deposit for new sends."],
            ["payeeHash / encryptedPayee", "Protocol matching data plus backend-only payment details."],
          ],
        },
        {
          name: "Pending Deposit",
          summary:
            "Temporary local record created after maker submits createDeposit but before the chain receipt is decoded.",
          fields: [
            ["id", "Local submission id."],
            ["status", "submitted, confirmed, or failed."],
            ["amount", "USDC escrow amount."],
            ["userOpHash", "Bundler hash used by deposit_reconcile."],
            ["txHash", "Chain transaction hash after success."],
            ["confirmedDepositId", "On-chain deposit id decoded from logs."],
            ["failureReason", "Why the deposit cannot become active."],
          ],
        },
        {
          name: "Deposit Submission DTO",
          summary:
            "The API response/mobile-facing object for a maker createDeposit attempt.",
          fields: [
            ["depositSubmissionId", "Local id mobile can poll."],
            ["status", "SUBMITTED, CONFIRMED, or FAILED."],
            ["userOpHash", "Hash shown for pending support/debug."],
            ["txHash", "Confirmed transaction hash."],
            ["depositId", "Final on-chain id needed for send matching."],
            ["failureReason", "Terminal explanation if creation failed."],
          ],
        },
        {
          name: "Stablecoin Transfer / Activity Row",
          summary:
            "The local history item created after fulfill succeeds so the receiver sees the Cash App-funded send as normal UPay activity.",
          fields: [
            ["sender_address", "Original UPay sender for product history, not necessarily the literal on-chain escrow sender."],
            ["recipient_address", "UPay receiver credited by fulfillIntent."],
            ["amount_atomic", "USDC amount in token atomic units."],
            ["execution_mode", "zkp2p for these sends; reserved-balance logic should still treat userop separately."],
            ["zkp2p_order_id", "Back-reference to the lifecycle order."],
            ["user_op_hash / tx_hash", "Fulfill hashes used for audit/support."],
          ],
        },
      ],
    },
    {
      title: "Prepare, Account Abstraction, And Contracts",
      concepts: [
        {
          name: "Prepare",
          summary:
            "A prepare step builds calldata and UserOperation options but does not mutate chain state by itself.",
          note:
            "Think of prepare as 'make the thing the user will sign'. Submit is 'send the signed thing'. Reconcile is 'prove what happened'.",
          fields: [
            ["prepareSignal", "Builds signalIntent calldata from stored order/maker/deposit data."],
            ["prepareFulfill", "Builds fulfillIntent calldata from intentHash and signed attestation data."],
            ["prepareDeposit", "Builds createDeposit calldata for maker cash-out liquidity."],
            ["returns", "Usually call data, target contract, gas estimates, nonce/context, and fields the wallet/passkey flow must sign."],
            ["does not do", "Does not reserve liquidity, verify payment, release funds, or mark final success."],
          ],
        },
        {
          name: "UserOperation",
          summary:
            "The account-abstraction transaction envelope sent to a bundler instead of directly sending an EOA transaction.",
          fields: [
            ["sender", "Smart account that will execute the call."],
            ["callData", "Encoded contract function call, such as signalIntent or fulfillIntent."],
            ["signature", "Passkey/session authorization proving the smart account approved the operation."],
            ["paymasterAndData", "Optional sponsorship data if gasless mode is used."],
            ["userOpHash", "Bundler-level id used by reconciliation jobs before a chain tx hash is known."],
          ],
        },
        {
          name: "Bundler / EntryPoint",
          summary:
            "Infrastructure that accepts UserOperations, simulates them, and submits them through the EntryPoint contract.",
          fields: [
            ["bundlerRpcUrl", "Backend endpoint used to send and later fetch UserOperation receipts."],
            ["entryPointAddress", "Contract that validates and executes the smart account operation."],
            ["receipt.success", "Boolean reconciliation uses to mark success/failure."],
            ["receipt.receipt.transactionHash", "Chain tx hash used to fetch logs and decode protocol events."],
          ],
        },
        {
          name: "Paymaster",
          summary:
            "Optional account-abstraction sponsor that can pay gas for a UserOperation.",
          fields: [
            ["enabled", "Whether gas sponsorship is attempted."],
            ["paymasterRpcUrl", "Service used to sponsor the operation."],
            ["policyId", "Optional sponsorship policy identifier."],
            ["simulation failure", "If sponsorship simulation reverts, no chain transaction happens and local state must not advance to success."],
          ],
        },
        {
          name: "Gating Signature",
          summary:
            "A signature proving the intent caller is allowed to reserve a gated deposit.",
          fields: [
            ["signer", "EOA configured in the maker deposit as the accepted gating service signer."],
            ["signature", "EIP-712/simple signature passed into signalIntent."],
            ["signatureExpiration", "Timestamp after which the contract should reject the gating signature."],
            ["caller / deposit / amount", "Inputs that must match what signalIntent actually sends, otherwise contract validation fails."],
          ],
        },
        {
          name: "Escrow / Deposit Contract",
          summary:
            "The ZKP2P protocol contract area where maker deposits, intents, fulfillments, and pruning happen.",
          fields: [
            ["deposit", "Maker's escrowed USDC plus verifier/gating/payee configuration."],
            ["signalIntent", "Function that reserves part of a deposit for a buyer/sender."],
            ["fulfillIntent", "Function that verifies the signed attestation and releases USDC."],
            ["pruneExpiredIntents", "Function that clears expired reservations so liquidity can be used again."],
            ["events", "IntentSignaled and IntentFulfilled logs decoded by reconciliation."],
          ],
        },
        {
          name: "Signal Intent",
          summary:
            "The on-chain reservation call that says this sender is claiming a specific amount from a maker deposit.",
          fields: [
            ["escrow / depositId", "Which maker liquidity is being reserved."],
            ["amount", "How much USDC is reserved."],
            ["to", "Receiver address that should get USDC after fulfillment."],
            ["paymentMethod / fiatCurrency", "Verifier/payment context."],
            ["conversionRate", "Rate basis used by protocol calculations."],
            ["gatingServiceSignature", "Authorization to use gated liquidity."],
          ],
        },
        {
          name: "Fulfill Intent",
          summary:
            "The on-chain release call after off-chain payment has been verified.",
          fields: [
            ["intentHash", "Reservation id being consumed."],
            ["paymentProof", "Attestation/proof bytes proving the fiat payment."],
            ["verificationData", "Structured verifier data needed by the contract/verifier."],
            ["releaseAmount", "Amount released to the receiver."],
            ["caller", "Smart account submitting the release through UserOperation."],
          ],
        },
        {
          name: "Contract Receipt / Event Log",
          summary:
            "The chain evidence reconciliation uses to turn pending local states into confirmed local states.",
          fields: [
            ["transactionHash", "Hash fetched from the UserOperation receipt."],
            ["IntentSignaled", "Log decoded to get intentHash and timestamp."],
            ["IntentFulfilled", "Log decoded to confirm release and final settlement."],
            ["CreateDeposit event", "Log decoded to identify the maker's deposit id."],
            ["field validation", "Decoded event values must match the stored order/deposit before local state updates."],
          ],
        },
      ],
    },
    {
      title: "Intent, Verification, Expiry, And Cleanup",
      concepts: [
        {
          name: "Intent",
          summary:
            "The active on-chain reservation created by signalIntent. It is the bridge between a maker deposit and a specific sender/receiver/payment.",
          fields: [
            ["intentHash", "Primary id for Buyer TEE, fulfillIntent, debug snapshots, and prune."],
            ["intentTimestampSeconds", "On-chain timestamp used to calculate expiration."],
            ["releaseAmount", "Amount reserved from the maker deposit."],
            ["receiver", "Address to receive USDC if fulfillment succeeds."],
            ["state", "active, expired, pruned, unknown, or none in support/debug views."],
          ],
        },
        {
          name: "Buyer TEE Input",
          summary:
            "Encrypted/mobile-collected payment verification input sent after the sender pays or claims they paid.",
          fields: [
            ["orderId", "Connects the verification attempt to the order."],
            ["intentHash", "Tells the verifier which on-chain reservation the payment corresponds to."],
            ["payment rail session/input", "Encrypted material used by the attestation service; should not appear in debug output."],
            ["senderAddress", "Used to bind verification to the expected sender/caller where needed."],
          ],
        },
        {
          name: "Attestation",
          summary:
            "The signed result of payment verification. It is the evidence fulfillIntent needs to release USDC.",
          fields: [
            ["intentHash", "Must match the order's signaled intent."],
            ["releaseAmount", "Must match the amount the contract should release."],
            ["dataHash", "Hash of verified payment details."],
            ["signature", "Attestation-service signature accepted by the verifier contract."],
            ["typedDataSpec", "EIP-712 shape describing what was signed, not instructions for logging into Cash App."],
          ],
        },
        {
          name: "Buyer TEE Attestation Job",
          summary:
            "The durable job that calls Peer/ZKP2P's Buyer TEE attestation service using stored encrypted input.",
          fields: [
            ["type", "buyer_tee_attestation."],
            ["phase", "buyer_tee."],
            ["status", "queued/running/succeeded/dead controls whether mobile sees retry_buyer_tee."],
            ["attempts", "Retry count used to decide when the job becomes dead."],
            ["lastErrorMessage", "Shown through lastFailure/statusReason, not as raw secret payload."],
          ],
        },
        {
          name: "Expiry",
          summary:
            "The rule that an intent is only payable for a limited time after it is signaled.",
          fields: [
            ["intentExpirationPeriod", "Contract/protocol window used to decide when payment is too late."],
            ["intentTimestampSeconds", "Signal time from chain, not a mobile clock guess."],
            ["EXPIRED status", "Terminal buyer state used to disable payment/fulfill actions."],
            ["intent_expiry_reconcile", "Job that checks/repairs/prunes expired reservations."],
          ],
        },
        {
          name: "Prune",
          summary:
            "The cleanup call that removes expired active intents and releases outstanding local liquidity accounting.",
          fields: [
            ["intentHash", "Expired reservation being pruned."],
            ["prune tx hash", "Chain transaction proving cleanup happened."],
            ["outstandingAmount decrement", "Local maker liquidity accounting released once."],
            ["retryable prune failure", "Buyer order remains EXPIRED while cleanup can be retried."],
          ],
        },
        {
          name: "Reconciliation",
          summary:
            "The backend process that checks external truth, then safely mutates local state.",
          fields: [
            ["input", "Usually orderId plus userOpHash, tx hash, or intentHash."],
            ["external read", "Bundler receipt, chain tx receipt, contract state, or attestation service response."],
            ["validation", "Decoded fields must match the stored order/deposit before state changes."],
            ["idempotency", "Repeated reconcile should not double-count liquidity or duplicate activity rows."],
            ["output", "Status update, event, tx hash, job success/failure, and possibly activity insertion."],
          ],
        },
      ],
    },
    {
      title: "Jobs, Events, And Support Surfaces",
      concepts: [
        {
          name: "Lifecycle Job",
          summary:
            "A durable retry record for asynchronous work. It is not pub/sub; it is a database row that endpoints or a worker can claim and process.",
          fields: [
            ["id", "Local job id."],
            ["type", "deposit_reconcile, signal_reconcile, buyer_tee_attestation, fulfill_reconcile, or intent_expiry_reconcile."],
            ["phase", "deposit, signal, buyer_tee, fulfill, or expiry."],
            ["resourceId", "The thing being reconciled, often userOpHash or intentHash."],
            ["orderId", "Back-reference when the job belongs to an order."],
            ["dedupeKey", "Prevents duplicate jobs for the same work."],
            ["status", "queued, running, succeeded, or dead."],
            ["attempts / runAfter", "Retry scheduling fields."],
            ["lastErrorCode / lastErrorMessage", "Support-safe failure context."],
          ],
        },
        {
          name: "Job Phase",
          summary:
            "A coarse bucket that says which part of the lifecycle the job belongs to.",
          fields: [
            ["deposit", "Maker cash-out createDeposit reconciliation."],
            ["signal", "Sender reserve-liquidity reconciliation."],
            ["buyer_tee", "Off-chain payment verification/attestation."],
            ["fulfill", "Final USDC release reconciliation."],
            ["expiry", "Expired intent repair/prune cleanup."],
          ],
        },
        {
          name: "Job Status",
          summary:
            "The retry state of a durable job.",
          fields: [
            ["queued", "Available for inline processing or background worker claim."],
            ["running", "Currently claimed by a processor."],
            ["succeeded", "Completed successfully; should not repeat side effects."],
            ["dead", "Exhausted retry attempts or hard-failed; may expose retry_buyer_tee for Buyer TEE."],
          ],
        },
        {
          name: "Lifecycle Event",
          summary:
            "Append-only audit trail of important state changes, job attempts, and failures.",
          fields: [
            ["id", "Local event id."],
            ["subjectType / subjectId", "What the event is about: order, deposit, job phase, etc."],
            ["orderId", "Optional direct link to the order."],
            ["eventType", "ORDER_CREATED, SIGNAL_SUBMITTED, BUYER_TEE_SUBMITTED, FULFILL_SUBMITTED, ZKP2P_JOB_* or ORDER_ADVANCE_ERROR."],
            ["severity", "info, warning, or error for support triage."],
            ["statusBefore / statusAfter", "State transition context."],
            ["jobId", "Job that produced the event, if any."],
            ["userOpHash / txHash", "External evidence pointers."],
            ["message / metadata", "Human explanation plus structured support details."],
          ],
        },
        {
          name: "Lifecycle Event Type",
          summary:
            "The vocabulary used to classify timeline entries in support/debug views.",
          fields: [
            ["ORDER_CREATED", "A new send order was created from a quote."],
            ["SIGNAL_SUBMITTED", "signalIntent UserOperation was submitted and signal_reconcile was queued."],
            ["BUYER_TEE_SUBMITTED", "Buyer payment verification input was stored and attestation was queued."],
            ["FULFILL_SUBMITTED", "fulfillIntent UserOperation was submitted and fulfill_reconcile was queued."],
            ["ORDER_ADVANCE_ERROR", "Read-time or inline state advancement hit an error."],
            ["ZKP2P_JOB_CLAIMED", "A worker or inline handler started processing a job."],
            ["ZKP2P_JOB_SUCCEEDED", "A job completed and side effects were applied or confirmed idempotently."],
            ["ZKP2P_JOB_RETRYABLE_FAILURE", "A job failed but remains queued for retry."],
            ["ZKP2P_JOB_DEAD", "A job exhausted retries or hard-failed."],
          ],
        },
        {
          name: "OrderLifecycle Module",
          summary:
            "The backend owner of send-order progression. Routes should call this module instead of mutating statuses directly.",
          fields: [
            ["createOrder", "Creates the local send order and initial lifecycle event."],
            ["getOrderView / listOrderViews", "Refreshes state before returning mobile-safe DTOs."],
            ["prepareSignal / submitSignal", "Builds and submits reserve-liquidity operations."],
            ["submitBuyerTee", "Stores verification input and queues attestation."],
            ["prepareFulfill / submitFulfill", "Builds and submits final release operations."],
            ["advanceOrder", "Centralized reconciliation/expiry advancement for stale pending states."],
          ],
        },
        {
          name: "LiquidityLifecycle Module",
          summary:
            "The backend owner of maker deposit reconciliation and liquidity indexing.",
          fields: [
            ["deposit_reconcile", "Confirms createDeposit UserOperations and decodes deposit ids."],
            ["active deposit indexing", "Makes confirmed deposits available for sender matching."],
            ["outstanding accounting", "Tracks reserved liquidity while intents are active."],
            ["remaining accounting", "Tracks liquidity consumed by fulfilled sends."],
            ["pause/empty/failure states", "Prevents unusable deposits from being matched."],
          ],
        },
        {
          name: "Inline Worker",
          summary:
            "Endpoint-triggered job processing used for fast UX before a full daemon/interval is relied on.",
          fields: [
            ["submit endpoints", "Queue a job, then immediately try to process it."],
            ["read endpoints", "May refreshBeforeRead to advance stale pending orders."],
            ["background worker", "Can later process the same queued jobs for durability."],
            ["pitfall", "Inline processing improves UX but still needs idempotent jobs because users can tap/poll repeatedly."],
          ],
        },
        {
          name: "Debug Snapshot",
          summary:
            "Authenticated support response that safely joins order, jobs, events, liquidity, and chain intent state.",
          fields: [
            ["order state", "Raw status, allowed actions, terminal flag, status reason."],
            ["latest events", "Recent lifecycle events for timeline debugging."],
            ["related jobs", "Retry/dead state and last error summaries."],
            ["deposit liquidity snapshot", "Remaining/outstanding state for the selected maker deposit."],
            ["chain intent summary", "active, expired, pruned, unknown, or none."],
            ["recommendedAction", "Human next step for support or self-service recovery."],
            ["redactions", "Never include private keys, cookies, passkeys, encrypted session material, raw proofs, or encrypted payee data."],
          ],
        },
        {
          name: "System Boundary",
          summary:
            "The lifecycle crosses mobile, backend DB, AA infrastructure, ZKP2P contracts, payment rails, and attestation services.",
          fields: [
            ["mobile", "Displays backend order views and sends signed UserOperations or Buyer TEE input."],
            ["backend", "Owns lifecycle decisions, storage, job retries, and support snapshots."],
            ["bundler/paymaster", "Submits and sponsors UserOperations."],
            ["contracts", "Hold deposits, intents, fulfillments, and prune logic."],
            ["payment rail", "Moves fiat outside the chain."],
            ["attestation service", "Verifies payment and signs proof for fulfillIntent."],
          ],
        },
      ],
    },
  ];

  const CONCEPT_EXAMPLES = {
    Sender:
      "A UPay sender wants to pay @moemix $1 but has no UPay balance. The sender signs signalIntent and later fulfillIntent, while Cash App is used for the fiat leg.",
    Receiver:
      "The receiver is @moemix. They do not interact with Cash App in this flow; they simply receive USDC after fulfill reconciliation confirms the release.",
    Maker:
      "A maker wants to cash out 10 USDC. They create a deposit with their Cash App payee, then a sender reserves $1 of that liquidity and pays the maker off-chain.",
    "Payment Rail":
      "Cash App is the rail in this mock. The same lifecycle could support another rail, but rail-specific normalization, payee display, and verification rules would change.",
    "Payment Instructions":
      "After INTENT_SIGNALED, the app can show 'send $1.00 to $maab161151'. Before that, showing those instructions is risky because the maker liquidity might not be reserved.",
    Quote:
      "A quote exists when the backend finds an active maker deposit with enough remaining liquidity for the sender's desired amount. The quote becomes an order only when the sender starts the send.",
    Order:
      "The order exists because one send crosses many systems. It gives mobile, jobs, support, attestation, and chain reconciliation one stable object to coordinate around.",
    "Order Status":
      "When signalIntent is submitted, the status becomes SIGNALING_INTENT. That tells mobile to wait, while the signal_reconcile job checks whether the chain reservation actually happened.",
    "Order View DTO":
      "A raw BUYER_TEE_INPUT_RECEIVED status is not enough for mobile. The DTO can say allowedActions is empty while the job is queued, or retry_buyer_tee if the job is dead.",
    "Allowed Action":
      "The app does not hard-code 'if status equals X, enable button Y'. It asks the backend, and the backend returns fulfill only after ATTESTATION_SIGNED.",
    "Maker Deposit":
      "Deposit 2607 starts with $10 remaining and $0 outstanding. After a $1 intent is signaled, outstanding becomes $1 so another sender cannot reserve that same dollar.",
    "Pending Deposit":
      "After the maker taps createDeposit, there is only a userOpHash. The pending deposit exists until deposit_reconcile decodes the real on-chain deposit id.",
    "Deposit Submission DTO":
      "The maker screen can show SUBMITTED immediately after createDeposit, then CONFIRMED with depositId 2607 once the chain receipt is decoded.",
    "Stablecoin Transfer / Activity Row":
      "When fulfill succeeds, the chain moved escrowed USDC, but the product still needs a history item saying sender paid receiver $1 through ZKP2P.",
    Prepare:
      "Prepare signal options exists because the backend can build calldata, but the user still has to sign it. If the user closes the app after prepare, nothing should be reserved.",
    UserOperation:
      "Instead of the mobile app sending a raw Base transaction, it submits a signed UserOperation. The backend tracks the userOpHash until a real tx hash exists.",
    "Bundler / EntryPoint":
      "When the app submits signalIntent, the bundler may accept a UserOperation but the chain transaction may still be pending. Reconciliation bridges that gap.",
    Paymaster:
      "If UPay sponsors gas, the paymaster simulation can fail before anything lands on-chain. The local order must not become INTENT_SIGNALED just because sponsorship was attempted.",
    "Gating Signature":
      "A maker deposit can require UPay's signer. The sender gets a gating signature for the exact caller/deposit/amount, and signalIntent reverts if those values do not match.",
    "Escrow / Deposit Contract":
      "The contract is the source of truth for whether deposit 2607 exists, whether an intent is active, and whether fulfillIntent released funds.",
    "Signal Intent":
      "signalIntent is created when the sender reserves $1 of deposit 2607 for @moemix. Without it, the sender could pay Cash App with no protected claim on maker liquidity.",
    "Fulfill Intent":
      "fulfillIntent is submitted after Buyer TEE signs the payment attestation. It consumes the intent and releases the reserved USDC to the receiver.",
    "Contract Receipt / Event Log":
      "The backend decodes IntentSignaled from the signal transaction. That event gives the intentHash needed for payment verification and future fulfill.",
    Intent:
      "An intent is the active reservation between 'sender owes maker fiat' and 'receiver can receive USDC'. If it expires, the buyer flow should stop and prune should release liquidity.",
    "Buyer TEE Input":
      "After the sender pays in Cash App, mobile submits encrypted verification input. The backend stores it and queues the attestation job instead of blocking the request forever.",
    Attestation:
      "The attestation says the TEE verified the payment for this intentHash and releaseAmount. fulfillIntent depends on this signed evidence.",
    "Buyer TEE Attestation Job":
      "A job is created when the backend receives Buyer TEE input. It is picked up inline by the endpoint or later by the worker, then calls the attestation service.",
    Expiry:
      "If the sender reserves liquidity at noon and never pays, the intent eventually expires. Mobile should stop showing payment actions after the valid window passes.",
    Prune:
      "After an expired intent is detected, pruneExpiredIntents clears it from the contract and the backend decrements outstanding liquidity so the maker's funds can be reused.",
    Reconciliation:
      "Reconciliation exists because submit does not equal success. signal_reconcile reads bundler and chain receipts before changing SIGNALING_INTENT into INTENT_SIGNALED.",
    "Lifecycle Job":
      "A job is created when work must survive request boundaries, like signal_reconcile after signalIntent submit. It is picked up by inline endpoint processing or the worker dispatcher.",
    "Job Phase":
      "If support sees phase buyer_tee, they know the issue is payment verification, not chain release. Phase is the broad area of the lifecycle.",
    "Job Status":
      "A buyer_tee job starts queued, becomes running when claimed, then succeeded after attestation or dead after repeated failures. Dead can expose retry_buyer_tee.",
    "Lifecycle Event":
      "When signalIntent is submitted, a SIGNAL_SUBMITTED event is written. Later, ZKP2P_JOB_SUCCEEDED records that reconciliation completed.",
    "Lifecycle Event Type":
      "If a support snapshot shows ZKP2P_JOB_DEAD after BUYER_TEE_SUBMITTED, support knows the order did not fail on-chain; verification exhausted retries.",
    "OrderLifecycle Module":
      "Routes call OrderLifecycle.submitSignal instead of directly setting status. That centralizes event writing, job enqueueing, and allowed action behavior.",
    "LiquidityLifecycle Module":
      "Maker deposits use LiquidityLifecycle so deposit_reconcile and liquidity accounting do not get mixed into the sender order code.",
    "Inline Worker":
      "After /signal/submit queues signal_reconcile, it immediately tries to run that job. If the receipt is not ready, polling can try again later.",
    "Debug Snapshot":
      "When a user says the banner is stuck, the debug snapshot can show order status, chain intent state, jobs, events, and recommended action without exposing secrets.",
    "System Boundary":
      "A single send touches mobile, backend, bundler, paymaster, ZKP2P contracts, Cash App, and the attestation service. The boundary map shows which system owns which truth.",
  };

  const PRECISE_UNIT = "1000000000000000000";
  const SEND_AMOUNT_ATOMIC = 1_000_000;
  const CASHOUT_AMOUNT_ATOMIC = 10_000_000;

  const els = {
    flowTitle: document.getElementById("flowTitle"),
    flowDescription: document.getElementById("flowDescription"),
    terminalBadge: document.getElementById("terminalBadge"),
    sendControls: document.getElementById("sendControls"),
    cashoutControls: document.getElementById("cashoutControls"),
    catalogPanel: document.getElementById("catalogPanel"),
    conceptsPanel: document.getElementById("conceptsPanel"),
    orderView: document.getElementById("orderView"),
    depositView: document.getElementById("depositView"),
    chainView: document.getElementById("chainView"),
    jobsView: document.getElementById("jobsView"),
    eventsView: document.getElementById("eventsView"),
    actionTitle: document.getElementById("actionTitle"),
    actionPhase: document.getElementById("actionPhase"),
    actionSummary: document.getElementById("actionSummary"),
    actionApp: document.getElementById("actionApp"),
    actionBackend: document.getElementById("actionBackend"),
    actionWhy: document.getElementById("actionWhy"),
    actionChanges: document.getElementById("actionChanges"),
    actionHistory: document.getElementById("actionHistory"),
    resetAll: document.getElementById("resetAll"),
  };

  const state = freshState();

  function freshState() {
    return {
      tab: "send",
      nextId: 1,
      order: null,
      payeeRegistered: false,
      depositOptionsPrepared: false,
      depositSubmission: null,
      pendingDeposit: null,
      makerDeposit: null,
      chainIntent: { state: "none", message: "No intent has been signaled." },
      jobs: [],
      events: [],
      lastAction: null,
      actionHistory: [],
      paymentOpened: false,
      fiatPaid: false,
      transferCreated: false,
    };
  }

  function id(prefix) {
    const value = `${prefix}_${String(state.nextId).padStart(3, "0")}`;
    state.nextId += 1;
    return value;
  }

  function now() {
    return new Date().toLocaleTimeString();
  }

  function fmtAtomic(value) {
    return `$${(Number(value || 0) / 1_000_000).toFixed(2)}`;
  }

  function copyFreshStateInto(target) {
    const next = freshState();
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, next);
  }

  function snapshot() {
    const order = state.order;
    const maker = state.makerDeposit;
    const pending = state.pendingDeposit;
    const submission = state.depositSubmission;
    const view = currentOrderView().view;
    const latest = state.jobs[0];
    return {
      tab: state.tab,
      orderStatus: order ? order.status : "",
      allowedActions: view.allowedActions.join(", ") || "none",
      terminal: String(view.terminal),
      orderId: order ? order.id : "",
      intentHash: order ? order.intentHash : "",
      chainIntent: state.chainIntent.state,
      makerStatus: maker ? maker.status : "",
      remaining: maker ? fmtAtomic(maker.remainingAmount) : "",
      outstanding: maker ? fmtAtomic(maker.outstandingAmount) : "",
      pendingDepositStatus: pending ? pending.status : "",
      depositSubmissionStatus: submission ? submission.status : "",
      payeeRegistered: state.payeeRegistered ? "yes" : "no",
      depositOptionsPrepared: state.depositOptionsPrepared ? "yes" : "no",
      fiatPaid: state.fiatPaid ? "yes" : "no",
      transferCreated: state.transferCreated ? "yes" : "no",
      latestJob: latest
        ? `${latest.type} / ${latest.phase} / ${latest.status} / attempts ${latest.attempts}`
        : "",
      jobCount: String(state.jobs.length),
      eventCount: String(state.events.length),
    };
  }

  const SNAPSHOT_LABELS = {
    tab: "tab",
    orderStatus: "order status",
    allowedActions: "allowed actions",
    terminal: "terminal",
    orderId: "order id",
    intentHash: "intent hash",
    chainIntent: "chain intent",
    makerStatus: "maker status",
    remaining: "remaining liquidity",
    outstanding: "outstanding liquidity",
    pendingDepositStatus: "pending deposit status",
    depositSubmissionStatus: "deposit submission status",
    payeeRegistered: "payee registered",
    depositOptionsPrepared: "deposit options prepared",
    fiatPaid: "fiat paid",
    transferCreated: "transfer created",
    latestJob: "latest job",
    jobCount: "job count",
    eventCount: "event count",
  };

  function buildStateChanges(before, after) {
    const changes = [];
    Object.keys(SNAPSHOT_LABELS).forEach((key) => {
      if (before[key] !== after[key]) {
        changes.push(`${SNAPSHOT_LABELS[key]}: ${before[key] || "-"} -> ${after[key] || "-"}`);
      }
    });
    return changes;
  }

  function recordButtonAction(label, before) {
    const explanation = ACTION_EXPLANATIONS[label] || {
      phase: "unknown",
      app: "The app ran a simulated button handler.",
      backend: "The simulator updated its in-memory mock state.",
      why: "This action is not mapped yet, so inspect the observed state changes below.",
    };
    const after = snapshot();
    const action = {
      label,
      phase: explanation.phase,
      app: explanation.app,
      backend: explanation.backend,
      why: explanation.why,
      changes: buildStateChanges(before, after),
      at: now(),
    };
    if (action.changes.length === 0) {
      action.changes.push("No mock state changed. This click only changed focus, repeated an already-applied action, or was a no-op.");
    }
    state.lastAction = action;
    state.actionHistory.unshift(action);
    state.actionHistory = state.actionHistory.slice(0, 8);
  }

  function sameJob(job, type, orderId) {
    return job.type === type && (!orderId || job.orderId === orderId);
  }

  function latestJob(type, orderId) {
    return state.jobs.find((job) => sameJob(job, type, orderId)) || null;
  }

  function createJob(type, phase, resourceId, orderId, payload) {
    const existing = state.jobs.find((job) => job.dedupeKey === `${type}:${resourceId}`);
    if (existing && existing.status === "dead") {
      existing.status = "queued";
      existing.attempts = 0;
      existing.lastErrorCode = "";
      existing.lastErrorMessage = "";
      existing.payload = payload || existing.payload;
      existing.updatedAt = now();
      return existing;
    }
    if (existing) return existing;

    const job = {
      id: id("job"),
      type,
      phase,
      resourceId,
      orderId: orderId || null,
      dedupeKey: `${type}:${resourceId}`,
      status: "queued",
      attempts: 0,
      runAfter: "now",
      lastErrorCode: "",
      lastErrorMessage: "",
      payload: payload || {},
      createdAt: now(),
      updatedAt: now(),
    };
    state.jobs.unshift(job);
    return job;
  }

  function recordEvent(input) {
    state.events.unshift({
      id: id("evt"),
      subjectType: input.subjectType || "order",
      subjectId: input.subjectId || input.orderId || "mock",
      orderId: input.orderId || "",
      eventType: input.eventType,
      severity: input.severity || "info",
      statusBefore: input.statusBefore || "",
      statusAfter: input.statusAfter || "",
      jobId: input.jobId || "",
      userOpHash: input.userOpHash || "",
      txHash: input.txHash || "",
      message: input.message || "",
      metadata: input.metadata || {},
      createdAt: now(),
    });
  }

  function claimJob(job) {
    if (!job || job.status === "running") return;
    job.status = "running";
    job.attempts += 1;
    job.updatedAt = now();
    recordEvent({
      eventType: "ZKP2P_JOB_CLAIMED",
      subjectType: job.orderId ? "order" : job.phase,
      subjectId: job.orderId || job.resourceId,
      orderId: job.orderId,
      jobId: job.id,
      message: `Claimed ${job.type}.`,
      metadata: { type: job.type, phase: job.phase, attempts: job.attempts },
    });
  }

  function succeedJob(job) {
    if (!job) return;
    if (job.status !== "running") claimJob(job);
    job.status = "succeeded";
    job.lastErrorCode = "";
    job.lastErrorMessage = "";
    job.updatedAt = now();
    recordEvent({
      eventType: "ZKP2P_JOB_SUCCEEDED",
      subjectType: job.orderId ? "order" : job.phase,
      subjectId: job.orderId || job.resourceId,
      orderId: job.orderId,
      jobId: job.id,
      message: `${job.type} succeeded.`,
      metadata: { type: job.type, phase: job.phase, attempts: job.attempts },
    });
  }

  function failJob(job, message, code, dead) {
    if (!job) return;
    if (job.status !== "running") claimJob(job);
    job.lastErrorCode = code;
    job.lastErrorMessage = message;
    job.status = dead || job.attempts >= 5 ? "dead" : "queued";
    job.updatedAt = now();
    recordEvent({
      eventType: job.status === "dead" ? "ZKP2P_JOB_DEAD" : "ZKP2P_JOB_RETRYABLE_FAILURE",
      severity: job.status === "dead" ? "error" : "warning",
      subjectType: job.orderId ? "order" : job.phase,
      subjectId: job.orderId || job.resourceId,
      orderId: job.orderId,
      jobId: job.id,
      message,
      metadata: { code, nextStatus: job.status, type: job.type, phase: job.phase },
    });
  }

  function changeOrderStatus(status, message) {
    if (!state.order) return;
    const before = state.order.status;
    state.order.status = status;
    state.order.updatedAt = now();
    if (message) state.order.statusMessage = message;
    return before;
  }

  function createSendOrder() {
    const createdAt = now();
    state.order = {
      id: id("order"),
      status: "CREATED",
      senderAddress: "0xsender",
      recipientAddress: "0xreceiver",
      recipientUsername: "moemix",
      makerAddress: "0xmaker",
      fiatAmount: "1.00",
      tokenAmount: String(SEND_AMOUNT_ATOMIC),
      fiatCurrency: "USD",
      platform: "cashapp",
      paymentInstructions: {
        platform: "cashapp",
        payee: "$maab161151",
        amount: "1.00",
        memo: "UPay demo",
      },
      signalIntentParams: {
        escrow: "0xescrow",
        depositId: "2607",
        amount: String(SEND_AMOUNT_ATOMIC),
        to: "0xreceiver",
        paymentMethod: "cashapp",
        fiatCurrency: "USD",
        conversionRate: PRECISE_UNIT,
      },
      intentHash: "",
      intentTimestampSeconds: "",
      signalUserOpHash: "",
      fulfillUserOpHash: "",
      signalTxHash: "",
      fulfillTxHash: "",
      failureReason: "",
      createdAt,
      updatedAt: createdAt,
    };
    state.chainIntent = { state: "none", message: "No intent has been signaled." };
    state.paymentOpened = false;
    state.fiatPaid = false;
    state.transferCreated = false;
    if (!state.makerDeposit) {
      state.makerDeposit = {
        id: "0xescrow:2607",
        depositId: "2607",
        status: "active",
        remainingAmount: CASHOUT_AMOUNT_ATOMIC,
        outstandingAmount: 0,
        acceptingIntents: true,
      };
    }
    recordEvent({
      orderId: state.order.id,
      eventType: "ORDER_CREATED",
      statusAfter: "CREATED",
      message: "ZKP2P order created from quote.",
    });
    render();
  }

  function prepareSignal() {
    if (!state.order) return;
    changeOrderStatus("SIGNAL_OPTIONS_CREATED", "Mock-only placeholder for prepared signal options.");
    render();
  }

  function submitSignal() {
    if (!state.order) return;
    const before = changeOrderStatus("SIGNALING_INTENT", "signalIntent UserOperation submitted.");
    state.order.signalUserOpHash = id("0xsignal_uop");
    createJob("signal_reconcile", "signal", state.order.signalUserOpHash, state.order.id, {
      orderId: state.order.id,
      userOpHash: state.order.signalUserOpHash,
    });
    recordEvent({
      orderId: state.order.id,
      eventType: "SIGNAL_SUBMITTED",
      statusBefore: before,
      statusAfter: "SIGNALING_INTENT",
      userOpHash: state.order.signalUserOpHash,
      message: "signalIntent submitted with status SIGNALING_INTENT.",
    });
    render();
  }

  function signalPending() {
    const job = latestJob("signal_reconcile", state.order && state.order.id);
    failJob(job, "signalIntent UserOperation receipt is not available yet.", "signal_receipt_pending");
    render();
  }

  function signalSuccess() {
    if (!state.order) return;
    const job = latestJob("signal_reconcile", state.order.id);
    succeedJob(job);
    changeOrderStatus("INTENT_SIGNALED", "Maker liquidity is reserved.");
    state.order.intentHash = id("0xintent");
    state.order.intentTimestampSeconds = String(Math.floor(Date.now() / 1000));
    state.order.signalTxHash = id("0xsignal_tx");
    state.order.txHash = state.order.signalTxHash;
    state.chainIntent = {
      state: "active",
      intentHash: state.order.intentHash,
      message: "Intent is active on-chain.",
    };
    if (state.makerDeposit) {
      state.makerDeposit.outstandingAmount += SEND_AMOUNT_ATOMIC;
    }
    createJob("intent_expiry_reconcile", "expiry", state.order.intentHash, state.order.id, {
      orderId: state.order.id,
      intentHash: state.order.intentHash,
    });
    render();
  }

  function signalFail() {
    if (!state.order) return;
    const job = latestJob("signal_reconcile", state.order.id);
    succeedJob(job);
    changeOrderStatus("FAILED", "signalIntent transaction failed.");
    state.order.failureReason = "signalIntent transaction failed.";
    render();
  }

  function openPayment() {
    state.paymentOpened = true;
    state.fiatPaid = true;
    render();
  }

  function submitBuyerTee() {
    if (!state.order) return;
    const before = changeOrderStatus(
      "BUYER_TEE_INPUT_RECEIVED",
      "Encrypted Buyer TEE input stored."
    );
    createJob("buyer_tee_attestation", "buyer_tee", state.order.id, state.order.id, {
      orderId: state.order.id,
      senderAddress: state.order.senderAddress,
    });
    recordEvent({
      orderId: state.order.id,
      eventType: "BUYER_TEE_SUBMITTED",
      statusBefore: before,
      statusAfter: "BUYER_TEE_INPUT_RECEIVED",
      message: "Buyer TEE payment verification input submitted.",
    });
    render();
  }

  function attestationRequestedPlaceholder() {
    if (!state.order) return;
    changeOrderStatus("ATTESTATION_REQUESTED", "Mock-only placeholder for old attestation request state.");
    render();
  }

  function buyerTeeSuccess() {
    if (!state.order) return;
    const job = latestJob("buyer_tee_attestation", state.order.id);
    succeedJob(job);
    changeOrderStatus("ATTESTATION_SIGNED", "Payment verified. Attestation signed.");
    render();
  }

  function buyerTeeRetryable() {
    const job = latestJob("buyer_tee_attestation", state.order && state.order.id);
    failJob(job, "Buyer TEE verification failed: 429 rate limited.", "buyer_tee_attestation_failed");
    render();
  }

  function buyerTeeDead() {
    const job = latestJob("buyer_tee_attestation", state.order && state.order.id);
    failJob(job, "Buyer TEE verification failed permanently in this mock.", "buyer_tee_attestation_failed", true);
    render();
  }

  function prepareFulfill() {
    if (!state.order) return;
    changeOrderStatus("FULFILL_OPTIONS_CREATED", "Mock-only placeholder for prepared fulfill options.");
    render();
  }

  function submitFulfill() {
    if (!state.order) return;
    const before = changeOrderStatus("FULFILLING_INTENT", "fulfillIntent UserOperation submitted.");
    state.order.fulfillUserOpHash = id("0xfulfill_uop");
    createJob("fulfill_reconcile", "fulfill", state.order.fulfillUserOpHash, state.order.id, {
      orderId: state.order.id,
      userOpHash: state.order.fulfillUserOpHash,
    });
    recordEvent({
      orderId: state.order.id,
      eventType: "FULFILL_SUBMITTED",
      statusBefore: before,
      statusAfter: "FULFILLING_INTENT",
      userOpHash: state.order.fulfillUserOpHash,
      message: "fulfillIntent submitted with status FULFILLING_INTENT.",
    });
    render();
  }

  function fulfillSuccess() {
    if (!state.order) return;
    const job = latestJob("fulfill_reconcile", state.order.id);
    succeedJob(job);
    changeOrderStatus("FULFILLED", "USDC released to receiver.");
    state.order.fulfillTxHash = id("0xfulfill_tx");
    state.order.txHash = state.order.fulfillTxHash;
    state.chainIntent = {
      state: "none",
      message: "Intent was consumed by fulfillIntent.",
    };
    if (state.makerDeposit) {
      state.makerDeposit.outstandingAmount = Math.max(
        state.makerDeposit.outstandingAmount - SEND_AMOUNT_ATOMIC,
        0
      );
      state.makerDeposit.remainingAmount = Math.max(
        state.makerDeposit.remainingAmount - SEND_AMOUNT_ATOMIC,
        0
      );
      if (state.makerDeposit.remainingAmount === 0) state.makerDeposit.status = "empty";
    }
    state.transferCreated = true;
    render();
  }

  function fulfillFail() {
    if (!state.order) return;
    const job = latestJob("fulfill_reconcile", state.order.id);
    succeedJob(job);
    changeOrderStatus("FAILED", "fulfillIntent UserOperation failed during execution.");
    state.order.failureReason = "fulfillIntent UserOperation failed during execution.";
    render();
  }

  function expireIntent() {
    if (!state.order) return;
    changeOrderStatus("EXPIRED", "Intent is expired on-chain and can be pruned.");
    state.chainIntent = {
      state: "expired",
      intentHash: state.order.intentHash,
      message: "Intent is expired on-chain and can be pruned.",
    };
    render();
  }

  function pruneSuccess() {
    if (!state.order) return;
    const job = latestJob("intent_expiry_reconcile", state.order.id);
    succeedJob(job);
    changeOrderStatus("EXPIRED", "Intent was pruned and maker liquidity should be released.");
    state.order.intentPrunedTxHash = id("0xprune_tx");
    state.chainIntent = {
      state: "pruned",
      intentHash: state.order.intentHash,
      txHash: state.order.intentPrunedTxHash,
      message: "Intent was pruned and maker liquidity should be released.",
    };
    if (state.makerDeposit && !state.makerDeposit.pruned) {
      state.makerDeposit.outstandingAmount = Math.max(
        state.makerDeposit.outstandingAmount - SEND_AMOUNT_ATOMIC,
        0
      );
      state.makerDeposit.pruned = true;
    }
    render();
  }

  function pruneFail() {
    if (!state.order) return;
    const job = latestJob("intent_expiry_reconcile", state.order.id);
    failJob(job, "pruneExpiredIntents transaction could not be submitted.", "intent_expiry_pending");
    changeOrderStatus("EXPIRED", "Expired locally, but prune has not released local outstanding liquidity.");
    state.chainIntent = {
      state: "expired",
      intentHash: state.order.intentHash,
      message: "Intent is expired, prune failed in this mock.",
    };
    render();
  }

  function repairExpiredStillActive() {
    if (!state.order) return;
    state.chainIntent = {
      state: "active",
      intentHash: state.order.intentHash,
      message: "Intent is active on-chain.",
    };
    changeOrderStatus("INTENT_SIGNALED", "Expired local state repaired because chain intent is still active.");
    render();
  }

  function registerPayee() {
    state.payeeRegistered = true;
    render();
  }

  function prepareDepositOptions() {
    state.depositOptionsPrepared = true;
    render();
  }

  function submitDeposit() {
    state.pendingDeposit = {
      id: id("zkp2p_dep"),
      status: "submitted",
      amount: CASHOUT_AMOUNT_ATOMIC,
      userOpHash: id("0xdeposit_uop"),
      txHash: "",
      confirmedDepositId: "",
      failureReason: "",
    };
    state.depositSubmission = {
      depositSubmissionId: state.pendingDeposit.id,
      status: "SUBMITTED",
      userOpHash: state.pendingDeposit.userOpHash,
    };
    state.makerDeposit = {
      id: state.pendingDeposit.id,
      depositId: "",
      status: "pending",
      remainingAmount: CASHOUT_AMOUNT_ATOMIC,
      outstandingAmount: 0,
      acceptingIntents: true,
    };
    createJob("deposit_reconcile", "deposit", state.pendingDeposit.userOpHash, null, {
      userOpHash: state.pendingDeposit.userOpHash,
    });
    render();
  }

  function depositReceiptPending() {
    const job = latestJob("deposit_reconcile");
    failJob(job, "Deposit UserOperation receipt is not available yet.", "deposit_receipt_pending");
    render();
  }

  function depositSuccess() {
    const job = latestJob("deposit_reconcile");
    succeedJob(job);
    if (state.pendingDeposit) {
      state.pendingDeposit.status = "confirmed";
      state.pendingDeposit.txHash = id("0xdeposit_tx");
      state.pendingDeposit.confirmedDepositId = "2607";
    }
    if (state.depositSubmission) {
      state.depositSubmission.status = "CONFIRMED";
      state.depositSubmission.txHash = state.pendingDeposit.txHash;
      state.depositSubmission.depositId = "2607";
    }
    if (state.makerDeposit) {
      state.makerDeposit.id = "0xescrow:2607";
      state.makerDeposit.depositId = "2607";
      state.makerDeposit.status = "active";
      state.makerDeposit.remainingAmount = CASHOUT_AMOUNT_ATOMIC;
      state.makerDeposit.outstandingAmount = 0;
    }
    render();
  }

  function depositFail() {
    const job = latestJob("deposit_reconcile");
    succeedJob(job);
    if (state.pendingDeposit) {
      state.pendingDeposit.status = "failed";
      state.pendingDeposit.failureReason = "Deposit UserOperation failed.";
    }
    if (state.depositSubmission) {
      state.depositSubmission.status = "FAILED";
      state.depositSubmission.failureReason = "Deposit UserOperation failed.";
    }
    if (state.makerDeposit) {
      state.makerDeposit.status = "failed";
      state.makerDeposit.remainingAmount = 0;
    }
    render();
  }

  function pauseDeposit() {
    if (state.makerDeposit) state.makerDeposit.status = "paused";
    render();
  }

  function resumeDeposit() {
    if (state.makerDeposit) state.makerDeposit.status = "active";
    render();
  }

  function emptyDeposit() {
    if (state.makerDeposit) {
      state.makerDeposit.status = "empty";
      state.makerDeposit.remainingAmount = 0;
      state.makerDeposit.outstandingAmount = 0;
    }
    render();
  }

  function switchTab(tab) {
    state.tab = tab;
    render();
  }

  function resetAll() {
    copyFreshStateInto(state);
    render();
  }

  function computeOrderViewState(input) {
    if (!input.status) {
      return {
        allowedActions: [],
        terminal: false,
        statusReason: "No order exists yet.",
      };
    }

    if (["FULFILLED", "FAILED", "EXPIRED"].includes(input.status)) {
      const failed = input.status === "FAILED";
      return {
        allowedActions: [],
        terminal: true,
        statusReason: failed
          ? input.failureReason || "This order failed and needs support review."
          : input.status === "EXPIRED"
            ? "The maker liquidity reservation expired."
            : "This order has been fulfilled.",
        lastFailure: failed
          ? {
              phase: "order",
              message: input.failureReason || "This order failed.",
              retryable: false,
            }
          : null,
      };
    }

    if (input.status === "CREATED") {
      return {
        allowedActions: ["signal"],
        terminal: false,
        statusReason: "Maker liquidity is ready to reserve.",
      };
    }

    if (input.status === "SIGNALING_INTENT") {
      return {
        allowedActions: [],
        terminal: false,
        statusReason: "Reserving maker liquidity on-chain.",
      };
    }

    if (input.status === "INTENT_SIGNALED") {
      return {
        allowedActions: ["open_payment", "submit_buyer_tee"],
        terminal: false,
        statusReason: "Maker liquidity is reserved. The Cash App payment can be verified.",
      };
    }

    if (input.status === "BUYER_TEE_INPUT_RECEIVED") {
      const job = (input.latestJobs || []).find(
        (candidate) => candidate.type === "buyer_tee_attestation" || candidate.phase === "buyer_tee"
      );
      if (!job) {
        return {
          allowedActions: ["retry_buyer_tee"],
          terminal: false,
          statusReason: "Payment verification needs to be retried.",
          lastFailure: {
            phase: "buyer_tee_attestation",
            message: "No active Buyer TEE verification job was found.",
            retryable: true,
          },
        };
      }
      if (job.status === "dead") {
        return {
          allowedActions: ["retry_buyer_tee"],
          terminal: false,
          statusReason: "Payment verification can be retried.",
          lastFailure: {
            phase: job.phase || job.type,
            message:
              job.lastErrorMessage ||
              job.lastError ||
              "Cash App payment verification did not complete.",
            retryable: true,
          },
        };
      }
      return {
        allowedActions: [],
        terminal: false,
        statusReason: "Verifying the Cash App payment.",
      };
    }

    if (input.status === "ATTESTATION_SIGNED") {
      return {
        allowedActions: ["fulfill"],
        terminal: false,
        statusReason: "Payment verified. USDC can be released to the receiver.",
      };
    }

    if (input.status === "FULFILLING_INTENT") {
      return {
        allowedActions: [],
        terminal: false,
        statusReason: "Releasing USDC to the receiver on-chain.",
      };
    }

    return {
      allowedActions: [],
      terminal: false,
      statusReason: "Order state is being refreshed.",
    };
  }

  function currentOrderView() {
    const order = state.order;
    const view = computeOrderViewState({
      status: order && order.status,
      failureReason: order && order.failureReason,
      latestJobs: state.jobs,
    });
    return { order, view };
  }

  function recommendedActionForOrderState(view) {
    if (view.allowedActions.includes("signal")) {
      return "Reserve maker liquidity before showing the buyer payment as actionable.";
    }
    if (view.allowedActions.includes("open_payment")) {
      return "Open the Cash App flow or submit Buyer TEE verification after paying.";
    }
    if (view.allowedActions.includes("retry_buyer_tee")) {
      return "Retry payment verification. If it fails repeatedly, inspect the Buyer TEE job error.";
    }
    if (view.allowedActions.includes("fulfill")) {
      return "Submit fulfillIntent to release USDC to the receiver.";
    }
    if (view.terminal) {
      return "No user action is available for this order.";
    }
    return "Wait for the current backend or chain step to finish, then poll the order again.";
  }

  function button(label, fn, options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (options && options.kind) btn.className = options.kind;
    if (options && options.disabled) btn.disabled = true;
    btn.addEventListener("click", () => {
      const before = snapshot();
      fn();
      recordButtonAction(label, before);
      render();
    });
    return btn;
  }

  function renderButtons(container, groups) {
    container.replaceChildren();
    groups.forEach((group) => {
      const row = document.createElement("div");
      row.className = "button-row";
      group.forEach((item) => row.appendChild(button(item.label, item.fn, item)));
      container.appendChild(row);
    });
  }

  function renderSendControls() {
    const order = state.order;
    const status = order && order.status;
    const buyerJob = latestJob("buyer_tee_attestation", order && order.id);

    renderButtons(els.sendControls, [
      [
        { label: "Create quote + order", fn: createSendOrder },
        {
          label: "Prepare signal options",
          fn: prepareSignal,
          kind: "secondary",
          disabled: !order || status !== "CREATED",
        },
        {
          label: "Submit signalIntent",
          fn: submitSignal,
          disabled: !order || !["CREATED", "SIGNAL_OPTIONS_CREATED"].includes(status),
        },
      ],
      [
        {
          label: "Signal receipt pending",
          fn: signalPending,
          kind: "warning",
          disabled: status !== "SIGNALING_INTENT",
        },
        {
          label: "Signal success",
          fn: signalSuccess,
          disabled: status !== "SIGNALING_INTENT",
        },
        {
          label: "Signal failure",
          fn: signalFail,
          kind: "danger",
          disabled: status !== "SIGNALING_INTENT",
        },
      ],
      [
        {
          label: "Open Cash App flow",
          fn: openPayment,
          disabled: status !== "INTENT_SIGNALED",
        },
        {
          label: "Submit Buyer TEE input",
          fn: submitBuyerTee,
          disabled: !["INTENT_SIGNALED", "BUYER_TEE_INPUT_RECEIVED"].includes(status),
        },
        {
          label: "Show ATTESTATION_REQUESTED",
          fn: attestationRequestedPlaceholder,
          kind: "secondary",
          disabled: !["BUYER_TEE_INPUT_RECEIVED"].includes(status),
        },
      ],
      [
        {
          label: "Buyer TEE success",
          fn: buyerTeeSuccess,
          disabled:
            !["BUYER_TEE_INPUT_RECEIVED", "ATTESTATION_REQUESTED"].includes(status) ||
            !buyerJob,
        },
        {
          label: "Buyer TEE retryable fail",
          fn: buyerTeeRetryable,
          kind: "warning",
          disabled: status !== "BUYER_TEE_INPUT_RECEIVED" || !buyerJob,
        },
        {
          label: "Buyer TEE dead",
          fn: buyerTeeDead,
          kind: "danger",
          disabled: status !== "BUYER_TEE_INPUT_RECEIVED" || !buyerJob,
        },
      ],
      [
        {
          label: "Prepare fulfill options",
          fn: prepareFulfill,
          kind: "secondary",
          disabled: status !== "ATTESTATION_SIGNED",
        },
        {
          label: "Submit fulfillIntent",
          fn: submitFulfill,
          disabled: !["ATTESTATION_SIGNED", "FULFILL_OPTIONS_CREATED"].includes(status),
        },
        {
          label: "Fulfill success",
          fn: fulfillSuccess,
          disabled: status !== "FULFILLING_INTENT",
        },
        {
          label: "Fulfill failure",
          fn: fulfillFail,
          kind: "danger",
          disabled: status !== "FULFILLING_INTENT",
        },
      ],
      [
        {
          label: "Expire intent",
          fn: expireIntent,
          kind: "warning",
          disabled: !["INTENT_SIGNALED", "BUYER_TEE_INPUT_RECEIVED", "ATTESTATION_SIGNED"].includes(status),
        },
        {
          label: "Prune success",
          fn: pruneSuccess,
          disabled: status !== "EXPIRED" || state.chainIntent.state !== "expired",
        },
        {
          label: "Prune failure",
          fn: pruneFail,
          kind: "danger",
          disabled: !["INTENT_SIGNALED", "BUYER_TEE_INPUT_RECEIVED", "ATTESTATION_SIGNED", "EXPIRED"].includes(status),
        },
        {
          label: "Repair expired still active",
          fn: repairExpiredStillActive,
          kind: "secondary",
          disabled: status !== "EXPIRED",
        },
      ],
    ]);
  }

  function renderCashoutControls() {
    const pending = state.pendingDeposit;
    const maker = state.makerDeposit;
    renderButtons(els.cashoutControls, [
      [
        { label: "Register Cash App payee", fn: registerPayee },
        {
          label: "Prepare deposit options",
          fn: prepareDepositOptions,
          disabled: !state.payeeRegistered,
        },
        {
          label: "Submit createDeposit",
          fn: submitDeposit,
          disabled: !state.depositOptionsPrepared,
        },
      ],
      [
        {
          label: "Deposit receipt pending",
          fn: depositReceiptPending,
          kind: "warning",
          disabled: !pending || pending.status !== "submitted",
        },
        {
          label: "Deposit success",
          fn: depositSuccess,
          disabled: !pending || pending.status !== "submitted",
        },
        {
          label: "Deposit failure",
          fn: depositFail,
          kind: "danger",
          disabled: !pending || pending.status !== "submitted",
        },
      ],
      [
        {
          label: "Pause maker deposit",
          fn: pauseDeposit,
          kind: "secondary",
          disabled: !maker || maker.status !== "active",
        },
        {
          label: "Resume maker deposit",
          fn: resumeDeposit,
          disabled: !maker || maker.status !== "paused",
        },
        {
          label: "Mark empty",
          fn: emptyDeposit,
          kind: "warning",
          disabled: !maker || !["active", "paused"].includes(maker.status),
        },
        {
          label: "Use this liquidity in Send tab",
          fn: function () {
            state.tab = "send";
            createSendOrder();
          },
          disabled: !maker || maker.status !== "active",
        },
      ],
    ]);
  }

  function renderCatalog() {
    const blocks = [
      ["Order statuses", ORDER_STATUSES],
      ["Order allowed actions", ALLOWED_ACTIONS],
      ["Maker deposit statuses", MAKER_DEPOSIT_STATUSES],
      ["Pending deposit statuses", PENDING_DEPOSIT_STATUSES],
      ["Deposit submission statuses", DEPOSIT_SUBMISSION_STATUSES],
      ["Job types", JOB_TYPES],
      ["Job phases", JOB_PHASES],
      ["Job statuses", JOB_STATUSES],
      ["Lifecycle event types", LIFECYCLE_EVENT_TYPES],
      ["Chain intent states", CHAIN_INTENT_STATES],
    ];
    els.catalogPanel.replaceChildren(
      ...blocks.map(([title, values]) => {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = title;
        const list = document.createElement("ul");
        values.forEach((value) => {
          const item = document.createElement("li");
          item.innerHTML = `<code>${value}</code>`;
          list.appendChild(item);
        });
        section.append(heading, list);
        return section;
      })
    );
  }

  function renderConcepts() {
    els.conceptsPanel.replaceChildren(
      ...CONCEPT_GROUPS.map((group) => {
        const section = document.createElement("section");
        section.className = "concept-group";
        const heading = document.createElement("h3");
        heading.textContent = group.title;
        section.appendChild(heading);

        group.concepts.forEach((concept) => {
          const card = document.createElement("article");
          card.className = "concept-card";
          const title = document.createElement("h4");
          title.textContent = concept.name;
          const summary = document.createElement("p");
          summary.textContent = concept.summary;
          card.append(title, summary);

          if (concept.note) {
            const note = document.createElement("p");
            note.className = "concept-note";
            note.textContent = concept.note;
            card.appendChild(note);
          }

          const example = document.createElement("p");
          const exampleLabel = document.createElement("strong");
          const exampleBody = document.createElement("span");
          example.className = "concept-example";
          exampleLabel.textContent = "Example: ";
          exampleBody.textContent =
            CONCEPT_EXAMPLES[concept.name] || "No example has been written for this concept yet.";
          example.append(exampleLabel, exampleBody);
          card.appendChild(example);

          const fields = document.createElement("ul");
          fields.className = "field-list";
          concept.fields.forEach(([name, use]) => {
            const item = document.createElement("li");
            const field = document.createElement("strong");
            const description = document.createElement("span");
            field.textContent = name;
            description.textContent = use;
            item.append(field, description);
            fields.appendChild(item);
          });
          card.appendChild(fields);
          section.appendChild(card);
        });

        return section;
      })
    );
  }

  function setKv(el, rows) {
    el.replaceChildren();
    rows.forEach(([key, value]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = key;
      if (value && value.nodeType) {
        dd.appendChild(value);
      } else {
        dd.innerHTML = value === undefined || value === null || value === "" ? "-" : String(value);
      }
      el.append(dt, dd);
    });
  }

  function pill(value) {
    const span = document.createElement("span");
    span.className = "pill";
    if (["FULFILLED", "active", "confirmed", "succeeded", "active"].includes(value)) {
      span.classList.add("green");
    }
    if (["EXPIRED", "queued", "running", "pending", "submitted"].includes(value)) {
      span.classList.add("yellow");
    }
    if (["FAILED", "failed", "dead"].includes(value)) {
      span.classList.add("red");
    }
    span.textContent = value || "-";
    return span;
  }

  function renderOrderView() {
    const { order, view } = currentOrderView();
    els.terminalBadge.textContent = `terminal: ${view.terminal}`;
    setKv(els.orderView, [
      ["status", order ? pill(order.status) : "-"],
      ["allowedActions", view.allowedActions.map((action) => `<code>${action}</code>`).join(" ") || "-"],
      ["statusReason", view.statusReason],
      ["lastFailure", view.lastFailure ? `${view.lastFailure.phase}: ${view.lastFailure.message}` : "-"],
      ["recommendedAction", recommendedActionForOrderState(view)],
      ["orderId", order && order.id],
      ["intentHash", order && order.intentHash],
      ["signalUserOpHash", order && order.signalUserOpHash],
      ["fulfillUserOpHash", order && order.fulfillUserOpHash],
      ["fiatPaid", state.fiatPaid ? "yes" : "no"],
      ["transferCreated", state.transferCreated ? "yes" : "no"],
    ]);
  }

  function renderDepositView() {
    const maker = state.makerDeposit;
    const pending = state.pendingDeposit;
    const submission = state.depositSubmission;
    setKv(els.depositView, [
      ["payeeRegistered", state.payeeRegistered ? "yes" : "no"],
      ["optionsPrepared", state.depositOptionsPrepared ? "yes" : "no"],
      ["submissionStatus", submission ? pill(submission.status) : "-"],
      ["pendingStatus", pending ? pill(pending.status) : "-"],
      ["makerStatus", maker ? pill(maker.status) : "-"],
      ["depositId", (maker && maker.depositId) || (pending && pending.confirmedDepositId)],
      ["remaining", maker ? fmtAtomic(maker.remainingAmount) : "-"],
      ["outstanding", maker ? fmtAtomic(maker.outstandingAmount) : "-"],
      ["acceptingIntents", maker ? String(maker.acceptingIntents) : "-"],
      ["failureReason", (pending && pending.failureReason) || (submission && submission.failureReason)],
    ]);
  }

  function renderChainView() {
    setKv(els.chainView, [
      ["state", pill(state.chainIntent.state)],
      ["intentHash", state.chainIntent.intentHash],
      ["txHash", state.chainIntent.txHash],
      ["message", state.chainIntent.message],
    ]);
  }

  function renderTable(container, columns, rows) {
    if (rows.length === 0) {
      container.innerHTML = '<p class="muted">No rows yet.</p>';
      return;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    const headRow = document.createElement("tr");
    columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column.label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      columns.forEach((column) => {
        const td = document.createElement("td");
        const value = column.value(row);
        if (value && value.nodeType) td.appendChild(value);
        else td.textContent = value === undefined || value === null ? "" : String(value);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    container.replaceChildren(table);
  }

  function renderJobs() {
    renderTable(
      els.jobsView,
      [
        { label: "id", value: (row) => row.id },
        { label: "type", value: (row) => row.type },
        { label: "phase", value: (row) => row.phase },
        { label: "status", value: (row) => pill(row.status) },
        { label: "attempts", value: (row) => row.attempts },
        { label: "resource", value: (row) => row.resourceId },
        { label: "last error", value: (row) => row.lastErrorMessage },
      ],
      state.jobs
    );
  }

  function renderEvents() {
    renderTable(
      els.eventsView,
      [
        { label: "time", value: (row) => row.createdAt },
        { label: "eventType", value: (row) => row.eventType },
        { label: "severity", value: (row) => row.severity },
        { label: "before", value: (row) => row.statusBefore },
        { label: "after", value: (row) => row.statusAfter },
        { label: "job", value: (row) => row.jobId },
        { label: "message", value: (row) => row.message },
      ],
      state.events
    );
  }

  function fillList(el, values) {
    el.replaceChildren();
    values.forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      el.appendChild(item);
    });
  }

  function renderActionExplainer() {
    const action = state.lastAction;
    if (!action) {
      els.actionTitle.textContent = "No action yet";
      els.actionPhase.textContent = "phase: none";
      els.actionSummary.textContent =
        "Click any simulated action to see what the mobile app did, what the backend did, and why that state change matters.";
      els.actionApp.textContent = "Waiting for a click.";
      els.actionBackend.textContent = "Waiting for a click.";
      els.actionWhy.textContent =
        "The explanation panel updates after every button so you can connect UI actions to backend state transitions.";
      fillList(els.actionChanges, ["No observed changes yet."]);
      fillList(els.actionHistory, ["No clicks yet."]);
      return;
    }

    els.actionTitle.textContent = action.label;
    els.actionPhase.textContent = `phase: ${action.phase}`;
    els.actionSummary.textContent = `${action.at} - This click ran the mock ${action.phase} phase handler.`;
    els.actionApp.textContent = action.app;
    els.actionBackend.textContent = action.backend;
    els.actionWhy.textContent = action.why;
    fillList(els.actionChanges, action.changes);
    fillList(
      els.actionHistory,
      state.actionHistory.map((item) => `${item.at} - ${item.label} (${item.phase})`)
    );
  }

  function render() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === state.tab);
    });

    els.sendControls.classList.toggle("hidden", state.tab !== "send");
    els.cashoutControls.classList.toggle("hidden", state.tab !== "cashout");
    els.catalogPanel.classList.toggle("hidden", state.tab !== "catalog");
    els.conceptsPanel.classList.toggle("hidden", state.tab !== "concepts");

    if (state.tab === "send") {
      els.flowTitle.textContent = "UPay Send Flow";
      els.flowDescription.textContent =
        "Sender buys USDC from maker liquidity, pays the maker in Cash App, verifies with Buyer TEE, then releases USDC to the UPay receiver.";
    } else if (state.tab === "cashout") {
      els.flowTitle.textContent = "Maker Cash Out Flow";
      els.flowDescription.textContent =
        "Maker registers a Cash App handle, escrows USDC into ZKP2P, and exposes liquidity that UPay senders can reserve.";
    } else if (state.tab === "catalog") {
      els.flowTitle.textContent = "State Catalog";
      els.flowDescription.textContent =
        "Every status, action, job type, phase, job status, lifecycle event type, and chain intent state represented in this mock.";
    } else {
      els.flowTitle.textContent = "Concept Map";
      els.flowDescription.textContent =
        "Every object this system touches, what it contains, and how those fields are used by mobile, backend lifecycle code, jobs, contracts, and support flows.";
    }

    renderSendControls();
    renderCashoutControls();
    renderCatalog();
    renderConcepts();
    renderOrderView();
    renderDepositView();
    renderChainView();
    renderJobs();
    renderEvents();
    renderActionExplainer();
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const before = snapshot();
      switchTab(tab.dataset.tab);
      recordButtonAction(`${tab.textContent} tab`, before);
      render();
    });
  });
  els.resetAll.addEventListener("click", () => {
    const before = snapshot();
    resetAll();
    recordButtonAction("Reset demo", before);
    render();
  });

  render();
})();
