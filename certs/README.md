# Custom CA certificates

This guide now lives on the documentation website: **[https://gitea-mirror.raylabs.io/docs/ca-certificates/](https://gitea-mirror.raylabs.io/docs/ca-certificates/)**

In Docker, put your `.crt` files in this folder and mount it at `/app/certs`, writable by the container user; the guide also covers a read-only setup, Kubernetes, bare metal and git. The page's source is [`www/src/pages/docs/ca-certificates.mdx`](../www/src/pages/docs/ca-certificates.mdx) in this repository, so a checkout of the release you run carries the matching version.
