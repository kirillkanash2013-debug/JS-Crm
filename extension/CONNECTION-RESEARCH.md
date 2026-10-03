# Connection research — 2026-09-30

## Inspected primary sources

- https://fbacc.io/ — published v6.4 bookmarklet, decompressed locally for inspection;
  no execution in a Facebook session, no third-party source included in this repo.
- https://chromewebstore.google.com/detail/dolphin-x-server/dihicliaoakcfiokadjibcobbemgdbgg —
  actual Chrome update-service package downloaded and inspected, manifest version 3.0.0.
  This is the publicly linked **Dolphin x Server** package, not proof of the current
  private Cloud collector implementation.
- https://docs.dolphin-anty.com/en/dolphin-cloud-and-parser/dolphin-anty-integration-with-dolphin-cloud
  — publisher documentation links the package and describes optional cookies/proxy transfer.

## Observations

FBacc scans already loaded script text for quoted EA credentials and stores its
selected credential in window.privateToken. Its getJSON function creates XHR
with withCredentials=true, running in the Facebook page. Requests include
access_token in the query string. Its published source uses v19.0. Its top copy
icon copies privateToken. Thus manual copying was not evidently the wrong icon.

Dolphin x Server's script collector executes locally in the active tab, obtains
inline scripts, selects scripts containing window.__accessToken, then extracts
quoted EA strings. It has cookies permission, obtains profile cookies on request,
and submits account data (access_token, user-agent, optional cookies/proxy/tags)
to the configured Dolphin service. No graph.facebook.com request appears in the
inspected bundle; account transfer is not itself the full stats collector.

Our failing path used a service-worker request, v25.0, Bearer header and
credentials=omit. Live diagnostics show code=1, HTTP 400, Invalid request
at identity. Changing to batch POST also failed. These observations do not
prove whether cookies, token placement, API version or another server policy
caused that rejection.

## Implemented minimal path

Keep Facebook requests in the selected Ads Manager page, read-only credentialed
XHR, access_token query parameter; use the existing v25.0 validation/pagination
and report logic. Prefer explicit FBacc/window.__accessToken candidates and
Dolphin-style script payloads. Require page user ID plus /me identity match,
and verify page identity for every subsequent request. No token/cookie transfer
to an external service, no proxy credentials intake and no ad mutations.

## Limits

27 fixture tests at implementation time. Live Facebook success remains unverified.
The page must stay open; no server-side autonomous collection. Browser profile
proxy is naturally used if configured. Additional proxy cannot be established as
necessary from the current error or from Dolphin's optional transfer feature.
