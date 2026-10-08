# Sandbox build networking

On macOS, coding tools, baseline checks, candidate checks and verification after
apply use the same host-owned forward proxy. The OS sandbox continues to deny
direct external connections. HTTP_PROXY/HTTPS_PROXY and their lowercase variants
point to a temporary loopback proxy; localhost backend/provider traffic bypasses
that proxy through NO_PROXY.

The default mode is `restricted`. Approved build-resource hosts include Google
Fonts, npm/Yarn registries, PyPI, GitHub download hosts, Node.js and Rust artifact
hosts. The exact defaults are in `src/repo/network.ts`. Google Fonts downloads
are real upstream responses; build results are never mocked or skipped.

Additional destinations can be configured in the terminal running Koda:

```sh
export KODA_SANDBOX_NETWORK_DOMAINS='assets.example.com,*.packages.example.com'
koda run --repo . --task "Implement the requested change" --apply
```

Entries extend the defaults. They must be comma-separated hostnames, with an
optional leading `*.` for subdomains. Global wildcards, URLs and IP literals are
rejected. Disable external build downloads with:

```sh
export KODA_SANDBOX_NETWORK=off
```

Unknown domains, unexpected ports and hosts resolving to private/loopback/
link-local addresses are blocked. DNS results are validated and pinned to the
upstream socket. Redirects to another host need that host to be permitted too.
The proxy listener and its sockets are closed after each sandbox command.
Nested sandbox commands cannot grant themselves bootstrap/network permissions.

HTTPS uses CONNECT tunnels with normal end-to-end certificate validation.
Plain HTTP resource downloads use GET/HEAD and omit authorization/cookie headers.
This policy does not change the CLI-to-backend model transport or expose the
backend's OpenRouter credential.

Clients must honor standard HTTP proxy variables. Clients attempting direct
external sockets remain blocked. Linux retains its existing isolated network
namespace; the macOS loopback proxy is not silently enabled by sharing the
host network on Linux. Dependency bootstrap retains its existing explicit setup
permissions. No unrestricted network mode is introduced for coding commands.

An infrastructure failure remains NOT_FULLY_VERIFIED. A new coding regression
remains FAILED. Neither candidate is automatically applied.
