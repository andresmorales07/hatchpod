---
name: docker-e2e
description: Build Docker image, start container, run Playwright e2e tests, and clean up
disable-model-invocation: true
---

Run the full e2e test suite against a fresh Docker container. Uses offset ports to avoid conflicts with the host hatchpod instance.

1. **Build**: `docker build -t hatchpod:latest .`
2. **Start** (offset ports 12222/18080 to avoid conflicts):
   ```
   docker run -d --name hatchpod-test \
     -p 12222:2222 -p 18080:8080 \
     -e API_PASSWORD=changeme \
     -e ENABLE_TEST_PROVIDER=1 \
     hatchpod:latest
   ```
3. **Wait for healthy**: poll `curl -sf http://localhost:18080/healthz` every 2 seconds until it responds (max 60s). If it never becomes healthy, show `docker logs hatchpod-test` and abort.
4. **Test** (pass offset ports via env vars):
   ```
   API_PORT=18080 API_PASSWORD=changeme npx playwright test
   ```
5. **Clean up**: `docker rm -f hatchpod-test`

Always clean up the container, even if tests fail. Report the full test results summary.

**Note**: If running inside a Sysbox container (check `mount | grep -q sysboxfs`), the sysbox-runc runtime is not available — use `--runtime runc` and note that Docker-in-Docker tests will not work.
