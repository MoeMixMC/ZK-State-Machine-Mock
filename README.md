# UPay ZKP2P State Machine Mock

This is a fully mocked, static webpage for understanding the UPay send and maker cash-out lifecycle.


## What It Contains

- `index.html` - the simulator page.
- `styles.css` - page styling.
- `app.js` - mocked state machine, jobs, lifecycle events, liquidity accounting, and chain intent states.

## How To Read It

Use the tabs at the top:

- `UPay Send` simulates a sender reserving maker liquidity, paying the maker, generating Buyer TEE verification, and fulfilling the intent.
- `Maker Cash Out` simulates a maker creating a deposit that becomes available liquidity.
- `Catalog` lists the exact statuses, allowed actions, job types, job phases, job statuses, event types, and chain intent states represented by the mock.
- `Concepts` explains every major entity the system touches, including orders, jobs, lifecycle events, intents, prepare steps, attestations, pruning, deposits, UserOperations, and support/debug surfaces. Each concept includes a concrete example of why it exists.

The right side of the page shows what the backend would be tracking: the order view, maker liquidity, chain intent, jobs, and lifecycle events.

This project does not call the real backend, chain, Peer, Cash App, or attestation service. It is intentionally a visual debugger for the lifecycle shape.
