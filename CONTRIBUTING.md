# Contributing

Thanks for considering a contribution.

This project controls physical desk movement over Bluetooth. Keep changes small, review behavior carefully, and test near the desk before trusting a change.

## Development

Run the app locally with:

```sh
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Use Chrome or Edge because Web Bluetooth is required.

## Before Opening a Pull Request

- Check that the page loads without console errors.
- Test layout at desktop and mobile widths.
- If changing Bluetooth behavior, test connect, stop, manual up/down, and move-to-height.
- Keep safety behavior conservative. Stop controls and connection errors should stay visible.
- Update the README when behavior, browser support, setup, or safety guidance changes.

## Reporting Desk Compatibility

When reporting compatibility with a desk, include:

- Desk or controller model, if known.
- Browser and operating system.
- Whether pairing was required through the browser or system dialog.
- What worked and what failed.
- Any visible error text from the app.
