import type { AuthenticationCredentialDto } from "../../shared/contracts/auth";
import type {
  Zkp2pOrderDebugDto,
  Zkp2pOrderDto,
} from "../../shared/contracts/zkp2p";
import { getAccountByAddress } from "../accountsDb";
import {
  canZkp2pIntentExpire,
  readZkp2pIntentChainSummary,
  reconcileExpiredZkp2pIntent,
  repairExpiredZkp2pIntentIfStillActive,
} from "./expiry";
import { createFulfillIntentOptions, submitFulfillIntent } from "./fulfill";
import {
  createZkp2pOrder as createZkp2pOrderAdapter,
} from "./orders";
import { receiveBuyerTeeInput } from "./buyerTee";
import { reconcileFulfillIntent, reconcileSignalIntent } from "./reconciliation";
import { createSignalIntentOptions, submitSignalIntent } from "./signal";
import {
  getZkp2pDepositDebugSnapshot,
  getZkp2pOrderById,
  getZkp2pOrderRecord,
  listZkp2pJobsByDedupeKeys,
  listZkp2pJobsForOrder,
  listZkp2pLifecycleEventsForOrder,
  listZkp2pOrderRecordsForViewer,
  recordZkp2pLifecycleEvent,
  type Zkp2pJobRecord,
  type Zkp2pOrderInternalRecord,
} from "./zkp2pDb";
import {
  computeOrderViewState,
  recommendedActionForOrderState,
  type Zkp2pOrderViewState,
} from "./orderState";

type Hex = `0x${string}`;

function dedupeJobs(jobs: Zkp2pJobRecord[]): Zkp2pJobRecord[] {
  const seen = new Set<string>();
  const unique: Zkp2pJobRecord[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    unique.push(job);
  }
  return unique.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function fallbackJobDedupeKeys(order: Zkp2pOrderInternalRecord): string[] {
  const keys = [`buyer_tee_attestation:${order.id}`];
  if (order.signalUserOpHash) {
    keys.push(`signal_reconcile:${order.signalUserOpHash}`);
  }
  if (order.fulfillUserOpHash) {
    keys.push(`fulfill_reconcile:${order.fulfillUserOpHash}`);
  }
  if (order.intentHash) {
    keys.push(`intent_expiry:${order.intentHash}`);
  }
  return keys;
}

async function getOrderJobs(order: Zkp2pOrderInternalRecord): Promise<Zkp2pJobRecord[]> {
  const [byOrder, byDedupe] = await Promise.all([
    listZkp2pJobsForOrder({ orderId: order.id }),
    listZkp2pJobsByDedupeKeys({ dedupeKeys: fallbackJobDedupeKeys(order) }),
  ]);
  return dedupeJobs([...byOrder, ...byDedupe]);
}

async function toOrderDto(
  record: Zkp2pOrderInternalRecord,
  viewState: Zkp2pOrderViewState
): Promise<Zkp2pOrderDto> {
  const recipient = await getAccountByAddress(record.recipientAddress).catch(() => null);
  return {
    id: record.id,
    status: record.status,
    allowedActions: viewState.allowedActions,
    terminal: viewState.terminal,
    statusReason: viewState.statusReason,
    lastFailure: viewState.lastFailure,
    senderAddress: record.senderAddress,
    recipientAddress: record.recipientAddress,
    recipientUsername: recipient?.username,
    makerAddress: record.makerAddress,
    amount: record.fiatAmount,
    fiatCurrency: "USD",
    paymentPlatform: record.platform,
    paymentInstructions: record.paymentInstructions ?? undefined,
    intentHash: record.intentHash ?? undefined,
    signalUserOpHash: record.signalUserOpHash ?? undefined,
    fulfillUserOpHash: record.fulfillUserOpHash ?? undefined,
    txHash: record.txHash ?? undefined,
    createdAtIso: new Date(record.createdAtMs).toISOString(),
    updatedAtIso: new Date(record.updatedAtMs).toISOString(),
  };
}

async function getOrderViewFromRecord(record: Zkp2pOrderInternalRecord): Promise<{
  dto: Zkp2pOrderDto;
  jobs: Zkp2pJobRecord[];
  viewState: Zkp2pOrderViewState;
}> {
  const jobs = await getOrderJobs(record);
  const viewState = computeOrderViewState({
    status: record.status,
    failureReason: record.failureReason,
    latestJobs: jobs.map((job) => ({
      type: job.type,
      phase: job.phase,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      lastErrorMessage: job.lastErrorMessage,
    })),
  });
  return { dto: await toOrderDto(record, viewState), jobs, viewState };
}

async function recordOrderEvent(input: {
  orderId: string;
  eventType: string;
  statusBefore?: string | null;
  statusAfter?: string | null;
  userOpHash?: Hex | null;
  txHash?: Hex | null;
  severity?: "info" | "warning" | "error";
  message?: string;
  metadata?: Record<string, unknown>;
}) {
  await recordZkp2pLifecycleEvent({
    subjectType: "order",
    subjectId: input.orderId,
    orderId: input.orderId,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    statusBefore: input.statusBefore,
    statusAfter: input.statusAfter,
    userOpHash: input.userOpHash,
    txHash: input.txHash,
    message: input.message,
    metadata: input.metadata,
  }).catch(() => null);
}

export async function advanceOrder(
  orderId: string,
  trigger: "read" | "signal_submit" | "buyer_tee_submit" | "fulfill_submit" | "worker"
): Promise<Zkp2pOrderInternalRecord | null> {
  const order = await getZkp2pOrderById(orderId);
  if (!order) return null;

  if (order.status === "SIGNALING_INTENT" && order.signalUserOpHash) {
    await reconcileSignalIntent(order.id, order.signalUserOpHash).catch((error) =>
      recordOrderEvent({
        orderId,
        eventType: "ORDER_ADVANCE_ERROR",
        severity: "warning",
        message: error instanceof Error ? error.message : "Signal reconcile failed.",
        metadata: { trigger, phase: "signal" },
      })
    );
  }

  const afterSignal = await getZkp2pOrderById(orderId);
  if (afterSignal?.status === "FULFILLING_INTENT" && afterSignal.fulfillUserOpHash) {
    await reconcileFulfillIntent(afterSignal.id, afterSignal.fulfillUserOpHash).catch((error) =>
      recordOrderEvent({
        orderId,
        eventType: "ORDER_ADVANCE_ERROR",
        severity: "warning",
        message: error instanceof Error ? error.message : "Fulfill reconcile failed.",
        metadata: { trigger, phase: "fulfill" },
      })
    );
  }

  const afterFulfill = await getZkp2pOrderById(orderId);
  if (afterFulfill && canZkp2pIntentExpire(afterFulfill.status)) {
    await reconcileExpiredZkp2pIntent(afterFulfill.id).catch((error) =>
      recordOrderEvent({
        orderId,
        eventType: "ORDER_ADVANCE_ERROR",
        severity: "warning",
        message: error instanceof Error ? error.message : "Expiry reconcile failed.",
        metadata: { trigger, phase: "expiry" },
      })
    );
  }

  const afterExpiry = await getZkp2pOrderById(orderId);
  if (afterExpiry?.status === "EXPIRED") {
    await repairExpiredZkp2pIntentIfStillActive(afterExpiry.id).catch((error) =>
      recordOrderEvent({
        orderId,
        eventType: "ORDER_ADVANCE_ERROR",
        severity: "warning",
        message: error instanceof Error ? error.message : "Expired-intent repair failed.",
        metadata: { trigger, phase: "expiry_repair" },
      })
    );
  }

  return getZkp2pOrderById(orderId);
}

export async function createOrder(
  senderAddress: `0x${string}`,
  input: { quoteId: string; idempotencyKey?: string }
): Promise<Zkp2pOrderDto> {
  const created = await createZkp2pOrderAdapter(senderAddress, input);
  await recordOrderEvent({
    orderId: created.id,
    eventType: "ORDER_CREATED",
    statusAfter: "CREATED",
    message: "ZKP2P order created from quote.",
  });
  return getOrderView(created.id, senderAddress);
}

export async function refreshBeforeRead(orderId: string): Promise<void> {
  await advanceOrder(orderId, "read");
}

export async function getOrderView(
  orderId: string,
  viewerAddress: `0x${string}`
): Promise<Zkp2pOrderDto> {
  const record = await getZkp2pOrderRecord({ orderId, viewerAddress });
  if (!record) {
    throw new Error("Order not found.");
  }
  await refreshBeforeRead(record.id);
  const fresh = await getZkp2pOrderRecord({ orderId, viewerAddress });
  if (!fresh) {
    throw new Error("Order not found.");
  }
  return (await getOrderViewFromRecord(fresh)).dto;
}

export async function listOrderViews(
  viewerAddress: `0x${string}`
): Promise<{ orders: Zkp2pOrderDto[] }> {
  const records = await listZkp2pOrderRecordsForViewer({ viewerAddress });
  for (const record of records) {
    await refreshBeforeRead(record.id);
  }

  const freshRecords = await listZkp2pOrderRecordsForViewer({ viewerAddress });
  return {
    orders: await Promise.all(
      freshRecords.map(async (record) => (await getOrderViewFromRecord(record)).dto)
    ),
  };
}

export async function prepareSignal(
  req: Request,
  senderAddress: `0x${string}`,
  orderId: string
) {
  return createSignalIntentOptions(req, senderAddress, orderId);
}

export async function submitSignal(
  req: Request,
  senderAddress: `0x${string}`,
  input: { intentId: string; credential: AuthenticationCredentialDto }
) {
  const result = await submitSignalIntent(req, senderAddress, input);
  await advanceOrder(result.orderId, "signal_submit");
  await recordOrderEvent({
    orderId: result.orderId,
    eventType: "SIGNAL_SUBMITTED",
    statusAfter: result.status,
    userOpHash: result.userOpHash,
    txHash: result.txHash,
    severity: result.status === "FAILED" ? "error" : "info",
    message: `signalIntent submitted with status ${result.status}.`,
  });
  return result;
}

export async function submitBuyerTee(input: {
  orderId: string;
  senderAddress: `0x${string}`;
  body: {
    platform: "cashapp";
    actionType: "transfer_cashapp";
    encryptedSessionMaterial: string;
    params: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}): Promise<Zkp2pOrderDto> {
  const before = await getZkp2pOrderById(input.orderId);
  await receiveBuyerTeeInput(input);
  await advanceOrder(input.orderId, "buyer_tee_submit");
  const after = await getZkp2pOrderById(input.orderId);
  await recordOrderEvent({
    orderId: input.orderId,
    eventType: "BUYER_TEE_SUBMITTED",
    statusBefore: before?.status,
    statusAfter: after?.status,
    message: "Buyer TEE payment verification input submitted.",
  });
  return getOrderView(input.orderId, input.senderAddress);
}

export async function prepareFulfill(
  req: Request,
  senderAddress: `0x${string}`,
  orderId: string
) {
  return createFulfillIntentOptions(req, senderAddress, orderId);
}

export async function submitFulfill(
  req: Request,
  senderAddress: `0x${string}`,
  input: { intentId: string; credential: AuthenticationCredentialDto }
) {
  const result = await submitFulfillIntent(req, senderAddress, input);
  await advanceOrder(result.orderId, "fulfill_submit");
  await recordOrderEvent({
    orderId: result.orderId,
    eventType: "FULFILL_SUBMITTED",
    statusAfter: result.status,
    userOpHash: result.userOpHash,
    txHash: result.txHash,
    severity: result.status === "FAILED" ? "error" : "info",
    message: `fulfillIntent submitted with status ${result.status}.`,
  });
  return result;
}

function getSignalRef(order: Zkp2pOrderInternalRecord): {
  escrowAddress: `0x${string}`;
  depositId: string;
} | null {
  if (
    !order.signalIntentParams ||
    typeof order.signalIntentParams !== "object" ||
    Array.isArray(order.signalIntentParams)
  ) {
    return null;
  }
  const params = order.signalIntentParams as Record<string, unknown>;
  const escrow = String(params.escrow ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(escrow)) return null;
  try {
    return {
      escrowAddress: escrow as `0x${string}`,
      depositId: BigInt(String(params.depositId)).toString(),
    };
  } catch {
    return null;
  }
}

export async function getOrderDebugSnapshot(
  orderId: string,
  viewerAddress: `0x${string}`
): Promise<Zkp2pOrderDebugDto> {
  const record = await getZkp2pOrderRecord({ orderId, viewerAddress });
  if (!record) {
    throw new Error("Order not found.");
  }
  await refreshBeforeRead(record.id);

  const fresh = await getZkp2pOrderRecord({ orderId, viewerAddress });
  if (!fresh) {
    throw new Error("Order not found.");
  }

  const view = await getOrderViewFromRecord(fresh);
  const [events, chainIntent] = await Promise.all([
    listZkp2pLifecycleEventsForOrder({ orderId: fresh.id, limit: 50 }),
    readZkp2pIntentChainSummary(fresh.id).catch(() => ({
      state: "unknown" as const,
      intentHash: fresh.intentHash ?? undefined,
      message: "Could not read chain intent state.",
    })),
  ]);
  const signalRef = getSignalRef(fresh);
  const deposit = signalRef
    ? await getZkp2pDepositDebugSnapshot(signalRef).catch(() => null)
    : null;

  return {
    order: view.dto,
    jobs: view.jobs.map((job) => ({
      id: job.id,
      type: job.type,
      phase: job.phase ?? undefined,
      status: job.status,
      attempts: job.attempts,
      runAfterMs: job.runAfterMs,
      lastErrorCode: job.lastErrorCode ?? undefined,
      lastErrorMessage: job.lastErrorMessage ?? job.lastError ?? undefined,
      createdAtMs: job.createdAtMs,
      updatedAtMs: job.updatedAtMs,
    })),
    lifecycleEvents: events.map((event) => ({
      id: event.id,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      orderId: event.orderId ?? undefined,
      eventType: event.eventType,
      severity: event.severity,
      statusBefore: event.statusBefore ?? undefined,
      statusAfter: event.statusAfter ?? undefined,
      jobId: event.jobId ?? undefined,
      userOpHash: event.userOpHash ?? undefined,
      txHash: event.txHash ?? undefined,
      message: event.message ?? undefined,
      metadata: event.metadata ?? undefined,
      createdAtMs: event.createdAtMs,
    })),
    deposit: deposit
      ? {
          escrowAddress: deposit.escrowAddress,
          depositId: deposit.depositId,
          remainingAmount: deposit.remainingAmount,
          outstandingAmount: deposit.outstandingAmount,
          acceptingIntents: deposit.acceptingIntents,
        }
      : undefined,
    chainIntent,
    recommendedAction: recommendedActionForOrderState(view.viewState),
  };
}
