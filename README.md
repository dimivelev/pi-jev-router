# Pi Jev Router

A Pi extension that asks Jev to classify each new text task, then selects a cheap or expensive chat model for the task. It works with Pi 0.87.1+ and Node 22.6+.

## Install globally

From this repository:

```sh
mkdir -p ~/.pi/agent/extensions/jev-router
cp index.ts policy.ts router-settings.ts ~/.pi/agent/extensions/jev-router/
```

Restart Pi or run `/reload`, then run `/jev-router` to open the settings menu. During development, load directly with `pi --extension ./index.ts` from this directory.

## Default configuration

- Jev backend: **OpenCode Zen**, model `jev-1.13-free` (OpenCode marks it limited-time)
- Cheap chat model: `opencode-go/deepseek-v4-flash`
- Expensive chat model: `openai-codex/gpt-6-astra`
- Minimum confidence for the cheap tier: `0.8`
- Automatic routing: **off** until `/jev-router on`

The menu can switch to standard OpenCode Zen `jev-1.13`, TypeSafe direct (`jev-latest`), or a custom Jev-compatible `/systemone` endpoint. OpenCode Zen is separate from the Go subscription; OpenCode's current published Go model list does not include Jev.

The menu also edits the cheap/expensive Pi model pair and confidence threshold. It verifies model availability, text input support, authentication, and Pi's `enabledModels`/`--models` scope.

## API keys

Set the environment variable for the selected backend before starting Pi, or use the menu's masked key entry for the current Pi process only:

- OpenCode Zen: `OPENCODE_API_KEY`
- TypeSafe: `TYPESAFE_API_KEY`
- Custom endpoint: `JEV_ROUTER_CUSTOM_API_KEY` (optional if the endpoint does not require auth)

The extension never saves API keys to disk. For persistent keys, export the variable in the shell/service that launches Pi. `.env.example` is a reference only; Pi does not load `.env` files automatically.

## Custom endpoint safety

Enter the complete URL ending in `/systemone`. HTTPS is required; plain HTTP is allowed only for localhost. URLs with credentials, query strings, or fragments are rejected. Redirects are disabled, and the menu asks you to confirm the custom host before saving it. Do not embed credentials in the URL; use the masked key field or `JEV_ROUTER_CUSTOM_API_KEY`.

Non-secret settings are saved to `~/.pi/agent/jev-router.json` with mode `0600`. Custom endpoints receive the task text and any custom API key configured for that backend, so use only a service you trust.

## Routing behavior

- A confident Jev `Choice` for `cheap` selects the cheap chat model.
- An expensive, uncertain, or malformed answer selects the expensive model.
- Jev errors/timeouts and prompts over 12,000 characters fail toward expensive.
- Prompts with images skip Jev and retain the current model.
- Pi restores the pre-router model after the task completes.

Only the current expanded prompt text is sent to Jev. Conversation history and image data are not sent; expanded `@file` or prompt-template text may be part of the prompt. Requests time out after six seconds. Provider usage charges may apply.

Optional environment overrides (a saved menu setting takes precedence):

```sh
export JEV_ROUTER_CHEAP_MODEL="provider/model-id"
export JEV_ROUTER_EXPENSIVE_MODEL="provider/model-id"
export JEV_ROUTER_CHEAP_CONFIDENCE="0.8" # 0..1
export JEV_ROUTER_AUTO=1                 # opt in at each Pi startup
```

## Commands

- `/jev-router` or `/jev-router menu` — open settings
- `/jev-router on` — enable routing for this session
- `/jev-router off` — disable routing and restore the prior model
- `/jev-router status` — show backend, key source (never the key), models, and threshold

## Development

No npm dependencies are required. Run the tests with:

```sh
npm test
```

The tests mock network calls and cover routing policy, the TypeSafe/OpenCode Zen/custom APIs, settings-file permissions, menu behavior, and session-only key masking.

## References

- [TypeSafe API quick start](https://docs.typesafe.ai/introduction/quickstart)
- [OpenCode Zen Jev](https://opencode.ai/docs/zen/#jev)
- [OpenCode Go model list](https://opencode.ai/zen/go/v1/models)
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/docs/extensions.md)
