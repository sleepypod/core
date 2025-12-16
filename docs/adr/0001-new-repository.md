# ADR: Why this project lives in a new repository

## Context
We chose to create a **new standalone repository** rather than contributing these changes to the original Free Sleep project after extensive discussion with the upstream maintainer.

### 1. Difference in contribution and review model (not quality goals)
The original project is intentionally maintained with:
- A high bar for review focused on protecting a large, non-technical user base
- A preference for changes that are **small, incremental, and narrowly scoped**
- Strong resistance to long-lived or multi-PR UI and architectural evolution in `main`

Our work **shares the same end goals**—stability, reliability, and ease of use—but differs in *how* those goals are achieved:
- We are developing a cohesive set of changes that are designed, tested, and validated together
- Many of these improvements only make sense when applied holistically rather than incrementally
- Reviewing them piecemeal would be higher risk and higher overhead than reviewing them as a complete, working system

This difference is about **scope and review approach**, not about stability standards. Additionally, we value delegation and 
believe that open source thrives when more people are empowered to contribute and innovate.

### 2. UI and architecture changes require holistic delivery
While the upstream project is open to UI improvements, the maintainer has clearly stated that:
- Iterative or partial UI rewrites are not something they are willing to review or maintain
- Larger redesigns must be complete, consistent, and fully validated before being considered
- They cannot commit the time required to review or shepherd such changes

Given this, continuing work as incremental pull requests or long-lived branches would be misaligned with the project’s expectations.

### 3. Long-lived branches are not a sustainable collaboration model
Maintaining a parallel branch that tracks upstream while pursuing a broader redesign would:
- Create constant merge and rebase pressure
- Increase the chance of subtle regressions
- Result in significant work that is unlikely to land in `main`

A separate repository makes the boundary explicit and avoids ongoing friction for both sides.

### 4. Respecting upstream ownership and constraints
This decision is not a criticism of the upstream project or its maintainer. Free Sleep’s maintainer has been clear about:
- Their limited available time
- Their responsibility to existing users
- Their desire to avoid becoming the gatekeeper for recurring full-scale redesigns

Creating a separate repository respects those constraints while allowing continued innovation elsewhere.

### 5. Clear expectations for contributors and users
A standalone repository:
- Sets accurate expectations that work here is intended to live here
- Allows independent roadmap and release cadence
- Lets users choose the implementation that best fits their preferences