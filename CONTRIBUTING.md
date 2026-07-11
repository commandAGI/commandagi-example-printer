# Contributing

Thanks for your interest! This is a community example for connecting a 3D printer to
[CommandAGI](https://commandagi.com). Small, focused improvements are very welcome:

- More printers / firmware quirks (baud rates, port hints, start-gcode gotchas).
- Clearer comments, docs, or safety guidance.
- Bug fixes in the serial driver or the connect flow.

## Ground rules

- Keep it **self-contained and readable** — this repo is a teaching example, not the
  production runtime. Prefer clarity over cleverness; no heavy dependencies.
- Run `npm run check` (`node --check` on the `.mjs` files) before opening a PR.
- Be honest about anything you're unsure of — mark it with a `TODO(commandagi)` and a
  link rather than guessing at an API shape.

Open an issue first for anything larger so we can align. By contributing you agree your
work is licensed under the repo's [MIT License](./LICENSE).
