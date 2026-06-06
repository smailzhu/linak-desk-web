# LINAK Desk Web

Browser-only controller for LINAK Bluetooth sit/stand desks, including IKEA IDASEN desks using the DPG controller family.

This is a static Web Bluetooth app. It does not require a native app, Python, Node.js, or a local helper process for normal use.

## Supported Browsers

Web Bluetooth is required.

- Chrome or Edge on desktop
- Chrome on Android
- HTTPS or `localhost`

Safari and Firefox generally do not expose the Web Bluetooth API needed by this app.

## Run Locally

From this directory:

```sh
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## Connect

Put the desk in Bluetooth pairing mode before connecting. When Chrome, Edge, or the system Bluetooth dialog opens, select the desk and choose Pair or Connect.

## Deploy

Any static HTTPS host works. Examples:

- GitHub Pages
- Cloudflare Pages
- Netlify
- Vercel static deployment

Keep the page private or access-controlled if you do not want other people to load it. The browser still requires a physical user gesture and per-origin Bluetooth permission before it can connect to a desk.

## Desk Protocol

The initial implementation follows the GATT services used by `rhyst/linak-controller`:

- Control service: `99fa0001-338a-1024-8a49-009c0215f78a`
- Control command characteristic: `99fa0002-338a-1024-8a49-009c0215f78a`
- DPG service: `99fa0010-338a-1024-8a49-009c0215f78a`
- DPG characteristic: `99fa0011-338a-1024-8a49-009c0215f78a`
- Reference output service: `99fa0020-338a-1024-8a49-009c0215f78a`
- Height/speed characteristic: `99fa0021-338a-1024-8a49-009c0215f78a`
- Reference input service: `99fa0030-338a-1024-8a49-009c0215f78a`
- Target height characteristic: `99fa0031-338a-1024-8a49-009c0215f78a`

Height values are encoded as tenths of a millimeter above the desk base height. The default base height is `620 mm`, and the app attempts to read the configured base offset from the DPG characteristic after connection.

## Safety

Watch the desk while moving it. The app sends normal LINAK BLE commands, but you are responsible for clearance, cable slack, load, and anything on or around the desk.
