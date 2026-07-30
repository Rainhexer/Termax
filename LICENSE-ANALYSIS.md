# Termax License Analysis

> Analysis of licensing options for Termax — a cross-platform terminal
> multiplexer and project manager for AI coding agents.
>
> Built with Tauri v2, Svelte, xterm.js, Monaco Editor.
> All dependency compatibility checks assume these are the project's
> direct and transitive dependencies.

---

## Current License: MIT

```
MIT License

Copyright (c) 2026 Ravn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**What it says:** "Do whatever you want, just keep the copyright notice."

### How it applies to Termax

- Anyone can take the Termax binary or source, redistribute it, sell it,
  or build a proprietary product on top.
- They only need to include your copyright notice.
- No source code disclosure required, even for modified versions.
- Compatible with every dependency Termax uses.

### Risks for Termax

- A company could fork Termax, add proprietary features, sell it as a
  closed-source product, and never contribute back.
- If AI agent platforms bundle Termax as their terminal UI, they don't
  owe you anything.
- No patent protection — if someone contributes a patented algorithm,
  there's no explicit grant of patent rights.
- Tauri apps compile to native binaries — redistribution of compiled
  binaries requires minimal effort.

---

## 1. Apache License 2.0

### What it adds over MIT

| Aspect | MIT | Apache 2.0 |
|---|---|---|
| Patent grant | Implicit (debated) | Express, explicit |
| Modified file notices | Not required | Required |
| Patent retaliation | None | Yes |
| Contributor agreement | None needed | Implicit |

### Why it matters for Termax

- The patent grant protects both you and contributors — if someone
  contributes a feature and later sues users for patent infringement,
  their license terminates.
- The notice requirement means companies distributing modified Termax
  binaries must acknowledge they changed things.
- Compatible with all dependencies (Monaco/MIT, xterm.js/Apache 2.0,
  Tauri/MIT-or-Apache).

### Verdict

If you want MIT-level permissiveness but with legal belt-and-suspenders,
this is the upgrade. Still doesn't prevent proprietary forks.

---

## 2. GNU General Public License v3 (GPLv3)

### Core mechanism

Copyleft — if you distribute Termax (binaries or source), the **entire
derivative work** must be GPLv3.

### How it constrains users

- Can't redistribute modified binaries without offering source code.
- Can't link Termax into a proprietary application.
- Can't distribute Termax as part of a closed-source product.
- Does **not** restrict internal use.
- Does **not** cover SaaS or network use (that's AGPLv3's job).

### Dependency compatibility with GPLv3

| Dependency | License | Compatible? |
|---|---|---|
| Tauri v2 | MIT OR Apache 2.0 | ✅ (pick MIT side) |
| xterm.js | Apache 2.0 | ✅ (GPLv3 compatible with Apache 2.0) |
| @xterm/addon-fit | Apache 2.0 | ✅ |
| Monaco Editor | MIT | ✅ |
| Svelte | MIT | ✅ |
| portable-pty (Rust) | MIT OR Apache 2.0 | ✅ (pick MIT) |
| notify (Rust) | MIT OR Apache 2.0 | ✅ |
| similar (Rust) | MIT OR Apache 2.0 | ✅ |
| Tailwind CSS | MIT | ✅ |
| Vite | MIT | ✅ |

No blockers. All transitive dependencies can be satisfied under
GPLv3-compatible terms.

### What GPLv3 does NOT do for Termax

**The AI agent SaaS loophole** — GPLv3 does **not** cover network use.
A company could run Termax on a hosted desktop or wrap its PTY backend
in a service, and as long as they never *distribute* the software, they
owe nothing. Only **AGPLv3** closes this door.

### Practical effects on community

- Some corporate developers will avoid Termax — legal departments often
  restrict GPL software.
- Some package managers have GPL-phobia (though Homebrew accepts GPL).
- AI agent platforms (the target market) tend to be GPL-averse.
- On the flip side, open-source enthusiasts will see it as "proper open
  source."

---

## 3. GNU General Public License v2 (GPLv2)

### The Apache 2.0 incompatibility problem

This is the critical issue. The Apache Software Foundation and FSF agree
that Apache 2.0 code **cannot** be combined with GPLv2-only code in a
single work.

This matters for Termax because several direct and transitive
dependencies are Apache 2.0:

- `@xterm/addon-fit`, `@xterm/addon-canvas`, `@xterm/addon-web-links`
  (Apache 2.0)
- Many Rust crates use "MIT OR Apache 2.0" dual license — you can
  sidestep by choosing MIT, but if any transitive dependency is
  Apache-2.0-only, you'd be in violation.

In practice, you'd need to audit your entire dependency tree
(Rust + npm) for Apache-2.0-only packages and either swap them out
or get exceptions. That's fragile and ongoing work with every update.

### Other problems with GPLv2 vs GPLv3

| Issue | GPLv2 | GPLv3 |
|---|---|---|
| Patent protection | None | Explicit patent grant + retaliation |
| Apache 2.0 compat | Incompatible | Compatible |
| Tivoization | Loophole | Closed |
| FSF recommendation | Legacy | Current |

### Verdict

Don't use GPL-2.0. If you want copyleft, GPLv3 is strictly better in
every dimension for an application like Termax. GPLv2 is a 1991 license
designed for a world without patents, SaaS, or locked-down devices. The
one valid use case for GPLv2 — Linux kernel module compatibility — does
not apply to a Tauri desktop app.

---

## 4. GNU Affero General Public License v3 (AGPLv3)

### What makes it different from GPLv3

> Section 13: "if you modify the program and make it available over a
> computer network, you must provide source code to remote users."

This closes the **SaaS loophole** — GPLv3 only triggers on distribution,
but AGPLv3 triggers on remote network interaction too.

### How it applies to Termax

Even though Termax is a desktop app today, consider:

- Someone could wrap Termax's backend in a web service (e.g., offer
  the terminal multiplexer as a cloud IDE feature).
- AI agent platforms could embed Termax's terminal and PTY logic
  server-side.
- Under AGPLv3, that cloud service must release its modified source
  to all users.

### Tradeoff

- Strongest protection for your work.
- Many corporations (especially in enterprise/AI) have blanket bans on
  AGPL — they see it as "viral" and high-risk.
- Tauri and all your Rust/Svelte deps are permissively licensed, so
  they're compatible, but the AGPL label itself scares people.

---

## 5. Mozilla Public License 2.0 (MPL 2.0)

### File-level copyleft

| Aspect | MPL 2.0 |
|---|---|
| Scope | Per file — modify a file, that file stays MPL |
| New files | Any license (including proprietary) |
| Combined works | Can be used in larger proprietary projects |
| Patent grant | Yes, explicit |

### Why it's interesting for Termax

- You protect your core files (PTY management, diff engine) — they must
  stay open.
- Someone could build a proprietary UI layer around them.
- More corporate-friendly than GPL (many companies allow MPL code).
- Used by: Firefox, LibreOffice.

### For a Tauri app

Since the Rust backend and Svelte frontend are separate files, MPL would
protect your Rust backend files (the unique value) while allowing the
frontend to be more flexible. But practically, a competitor could still
replace the frontend entirely.

---

## 6. Business Source License 1.1 (BSL)

### How it works

- **Now:** Source is available. Production use is limited (e.g., 2 users
  or 1 instance).
- **Future:** After 3-4 years ("change date"), it converts to GPLv2 or MIT.
- Non-production use (dev, testing, personal) is free.
- Commercial production use requires a paid license.

### Why consider it for Termax

- AI coding agents are a commercial space — companies would pay.
- Free licenses for individuals and open-source contributors.
- Converts to real open-source later, so the community gets the code
  eventually.
- Used by: MariaDB, CockroachDB (previously), Couchbase, Mattermost.

### Risks

- Community may reject it as "not really open source" — hurts grassroots
  adoption.
- Confusion around what "production use" means for a terminal tool.
- Enforcement burden — you'd need to track who's using it commercially.

---

## 7. Dual-license (e.g., AGPLv3 + Commercial)

### Two versions of the same code

- **AGPLv3:** Free, but any use/distribution/network interaction triggers
  copyleft.
- **Commercial license:** Pay for the right to use, modify, and distribute
  without copyleft obligations.

### Who does this

- MySQL (GPLv2 + Commercial)
- Qt (LGPL + Commercial)
- Redis (BSL, formerly dual-licensed)
- Sidekiq (LGPL + Commercial)

### For Termax

- Individual developers and open-source projects use the AGPL version
  for free.
- Companies that bundle Termax with their AI platform buy a commercial
  license.
- You get community adoption + revenue stream.

### The hard part

- You need to own all the copyright (or have CLAs from contributors).
- Legal setup costs (license text, commercial terms, pricing).
- Enforcement is on you.

---

## 8. Where VS Code fits

**VS Code uses the MIT License** — just like Termax currently does.

But there's an important nuance:

- **VS Code (the open-source repository `Microsoft/vscode`)** is MIT
  licensed.
- **VS Code (the official Microsoft binary download)** includes proprietary
  Microsoft telemetry, extensions marketplace, and branding — it's under
  a separate Microsoft Software License that restricts redistribution.
- This is the same model used by **GitHub Codespaces**, **Cursor**,
  **Windsurf**, **Positron**, and most VS Code forks: MIT source,
  proprietary product.

This is a strong reference point for Termax:

- Keep the source **MIT** (like VS Code).
- Distribute official binaries under a more restrictive license.
- Monetize via enterprise features, managed services, or commercial
  licensing.

VS Code's MIT choice is deliberate — it maximizes ecosystem adoption
(extensions, forks, integrations) while Microsoft reserves the right to
make money off the official branded binary. That model maps well to a
terminal multiplexer for AI agents where growth comes from community
adoption and revenue comes from enterprise/pro features.

---

## Decision Matrix

| Your priority | Best license |
|---|---|
| Maximum adoption, zero friction | **MIT** (current) |
| Adoption + patent safety | **Apache 2.0** |
| Protect from proprietary forks | **GPLv3** |
| Prevent SaaS/cloud competition | **AGPLv3** |
| Protect core files, flexible use | **MPL 2.0** |
| Monetize + open-source community | **Dual-license (AGPL + Commercial)** |
| Time-limited commercial edge | **BSL 1.1** |

## Dependency Compatibility Quick Reference

| License | Compatible with Termax deps? | Notes |
|---|---|---|
| MIT | ✅ Yes | Already using it |
| Apache 2.0 | ✅ Yes | Fully compatible |
| GPLv3 | ✅ Yes | All deps have GPLv3-compatible paths |
| GPLv2 | ❌ No | Apache 2.0 dependency conflict |
| AGPLv3 | ✅ Yes | Same deps as GPLv3 |
| MPL 2.0 | ✅ Yes | Compatible with all listed deps |
| BSL 1.1 | ✅ N/A | Source-available, not open-source |
