/**
 * The executor and user code share one terminal error, exported by the SDK,
 * so an error a bundled adapter or a producer raises is classified the same
 * way as one the shim raised. `isTerminal` rather than `instanceof`, because
 * a bundle inlines its own copy of the SDK.
 */

export { isTerminal, TerminalError } from "@puppi/sdk";
