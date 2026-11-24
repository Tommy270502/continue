/**
 * The VS Code extension identifier (`<publisher>.<name>` from package.json).
 * Keep in sync with the `publisher` and `name` fields in package.json.
 *
 * Note: command IDs, view IDs and config keys intentionally keep the
 * `continue.*` namespace so existing settings and keybindings keep working.
 */
export const EXTENSION_ID = "tommy270502.continue-custom";

/** Prefix of the URI path VS Code gives this extension's Output channels. */
export const EXTENSION_OUTPUT_CHANNEL_PREFIX = `output:extension-output-${EXTENSION_ID}`;
