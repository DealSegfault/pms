/**
 * Shared JS-side UDS command contract constants.
 *
 * This list must stay in sync with C++ IdempotencyActor::isMutatingOp().
 * See scripts/check-uds-idempotency-contract.mjs for parity enforcement.
 */

export const UDS_MUTATING_COMMAND_OPS = Object.freeze([
    // Core OMS writes
    'new',
    'trade',
    'execute_trade',
    'cancel',
    'cancel_order',
    'upsert_account',
    'upsert_rule',
    'upsert_position',
    'upsert_exchange_position',
    'close',
    'close_position',
    'close_all',
    'close_all_positions',

    // Strategy lifecycle writes
    'chase_start',
    'chase_cancel',
    'scalper_start',
    'scalper_cancel',
    'twap_start',
    'twap_stop',
    'basket_start',
    'basket_stop',
    'trail_start',
    'trail_cancel',
    'smart_order',
    'smart_order_stop',
    'agent_start',
    'agent_stop',
]);

export const UDS_MUTATING_COMMAND_OPS_SET = new Set(UDS_MUTATING_COMMAND_OPS);
