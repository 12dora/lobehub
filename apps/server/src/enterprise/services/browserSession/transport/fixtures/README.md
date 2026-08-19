# Test-only TLS material

`localhost-cert.pem` / `localhost-key.pem` are a self-signed certificate pair
for `localhost` / `127.0.0.1`. They exist only so the C3 HTTP/2 vitest fixture
can terminate TLS without talking to the network.

Not a secret. Do not use outside tests.
