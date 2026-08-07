---
name: router-budgeting
description: Use before an agent plans cost-bearing model calls or external service calls through the router plugin.
---

# Router Budgeting

Before making an expensive model call or using a cost-bearing external service,
call the `router_spend` tool with the spend target, consumer name, and estimated
United States dollar amount.

If the tool returns a budget refusal, do not make the expensive call. Surface
the structured refusal and ask Jose how to proceed.

Known spend targets include `local`, `cheap`, `mid`, `frontier`, `classify`,
`embed`, `local-embed`, `fal`, and `vercel-ai-gateway`.
