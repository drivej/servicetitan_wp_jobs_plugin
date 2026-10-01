# ServiceTitan WP Jobs SaaS — Agent Handoff

## Purpose

We are converting an existing ServiceTitan/WordPress application into a commercial multi-user SaaS product.

The existing application already performs useful ServiceTitan → AI → WordPress functionality. **Do not rewrite or replace working functionality until you have inspected and documented the existing implementation.**

The goal is to move account management, ServiceTitan integration, AI processing, usage metering, billing, and configuration into a hosted SaaS application while retaining a lightweight WordPress plugin as the website integration/publishing layer.

---

# Infrastructure

A Sevalla project already exists:

**Project:** `ServiceTitan WP Jobs Plugin`

The project is currently essentially empty and does not yet have a production database.

The target infrastructure is:

- Sevalla application hosting
- PostgreSQL on Sevalla
- Git-based deployment
- Google authentication
- Stripe billing
- ServiceTitan API integration
- AI API integration
- Existing WordPress plugin

Use the Sevalla CLI/API where appropriate.

Before modifying Sevalla:

1. Determine whether the Sevalla CLI is installed.
2. Determine whether it is authenticated.
3. Inspect the existing Sevalla project and resources.
4. Report what exists.
5. Do **not** create/delete/change infrastructure until the proposed architecture has been reviewed.

Never expose API keys, secrets, tokens, ServiceTitan credentials, Stripe secrets, or other credentials in source control.

---

# Product Model

For v1, the **User is the account and billing boundary**.

A user can own/configure multiple websites.

Conceptually:

```text
User
 ├── Google Identity
 ├── Subscription
 ├── ServiceTitan Connection(s)
 ├── Monthly Usage
 │
 └── Websites
      ├── Website A
      ├── Website B
      └── Website C
```

Usage is pooled at the User level across all websites.

Do NOT introduce Organizations/Teams unless the existing code or a concrete requirement makes them necessary.

The architecture should, however, avoid making a future migration to organizations unnecessarily difficult.

---

# Authentication

Authentication should initially be:

**Google only**

No local username/password authentication is required.

The application must still maintain its own User record associated with the Google identity.

At minimum, retain:

```text
users

id
google_subject / provider identifier
email
name
avatar_url
created_at
updated_at
last_login_at
```

Exact schema is not yet finalized.

Do not use email alone as the permanent Google identity key.

---

# Websites

A User can configure multiple websites.

Conceptually:

```text
websites

id
user_id
name
url
status
connection credentials
settings
created_at
updated_at
```

Each WordPress installation will eventually authenticate with the SaaS.

The WordPress plugin should ultimately become a relatively thin connector responsible primarily for:

- authenticating the WordPress site with the SaaS
- receiving/retrieving generated content
- creating/updating WordPress content
- reporting publication results/errors
- maintaining WordPress-specific configuration where appropriate

ServiceTitan credentials and AI provider credentials should NOT need to live inside individual WordPress installations.

---

# ServiceTitan

The SaaS backend should become responsible for communicating with ServiceTitan.

Do not assume one ServiceTitan connection forever.

V1 may initially expose one connection per User, but the schema should support multiple ServiceTitan connections in the future.

Potential future relationship:

```text
User
 ├── ServiceTitan Connection A
 │     └── Website A
 │
 └── ServiceTitan Connection B
       ├── Website B
       └── Website C
```

ServiceTitan credentials must be treated as sensitive secrets and stored appropriately.

Avoid retaining unnecessary customer PII from ServiceTitan.

Before redesigning this integration, inspect how the existing application currently:

- authenticates with ServiceTitan
- retrieves jobs
- determines eligible jobs
- processes updates
- maps ServiceTitan data to content
- stores state
- prevents duplicate processing

Document those findings first.

---

# Subscription Plans

The application will charge a recurring monthly subscription through Stripe.

There will be multiple tiers.

Plans differ primarily by the number of allowed:

**ServiceTitan job pushes/updates per billing period**

Example only:

```text
Starter
100 job pushes/updates

Growth
500 job pushes/updates

Pro
2,000 job pushes/updates
```

These numbers and prices are NOT final.

Do not hard-code them.

---

# Plan Versioning / Historical Pricing

We need a permanent record of pricing and entitlement changes.

Do NOT overwrite historical plan pricing.

Separate the conceptual Plan from its pricing/entitlement versions.

For example:

```text
plans

id
name
active
created_at
retired_at
```

and:

```text
plan_prices

id
plan_id

monthly_price
currency

monthly_job_limit
max_websites

stripe_price_id

effective_from
effective_to

created_at
```

Example:

```text
Growth

Version 1
$49/month
500 jobs
Jan 1 → Jun 30

Version 2
$69/month
750 jobs
Jul 1 →
```

An existing customer may remain grandfathered on Version 1 while new customers receive Version 2.

Historical pricing/entitlement records should effectively be immutable.

---

# Subscriptions

Subscriptions belong to Users.

Conceptually:

```text
subscriptions

id
user_id
plan_price_id

stripe_customer_id
stripe_subscription_id

status

started_at
ended_at

current_period_start
current_period_end

created_at
updated_at
```

We must be able to determine historically:

- which plan a user had
- what they were paying
- what entitlement they had
- when that entitlement was active

Do not simply store `current_plan` on the User and overwrite it.

---

# Payments / Invoices

Stripe is the payment processor and source of truth for actual payment activity.

We should maintain enough local billing history for application support, reporting, and auditing.

Conceptually:

```text
payments

id
user_id
subscription_id

stripe_invoice_id
stripe_payment_intent_id

amount
currency
status

period_start
period_end

paid_at
created_at
```

Consider whether `invoices` and `payments` should actually be separate tables after reviewing Stripe's data model.

Do not blindly implement the preliminary schema if a better normalized model is appropriate.

Refunds, credits, failures, and corrections should not destroy historical records.

---

# Usage Metering

Customers should NOT be billed or limited based directly on AI tokens.

The customer-facing usage unit is:

**Job push/update**

Examples:

```text
47 / 100 job updates used
318 / 500 job updates used
```

Usage is pooled across all Websites owned by the User.

Conceptually:

```text
usage_events

id
user_id
website_id
service_titan_job_id

event_type
billing_period

created_at
```

The exact definition of a billable usage event must be established carefully.

Important questions include:

- Does initial publication count as one usage event?
- Does updating an existing job count?
- Do retries count?
- Does a failed AI generation count?
- Does a failed WordPress publication count?
- Does regenerating content manually count?

**Do not implement usage billing until these semantics are explicitly defined.**

The system must be idempotent so retries cannot accidentally consume multiple credits.

---

# Internal AI Cost Tracking

Although customers consume "job pushes/updates," internally we need to understand AI costs.

For every AI generation, retain useful operational information such as:

```text
model
input_tokens
output_tokens
estimated_cost
generation timestamp
prompt/version
associated job
associated user
associated website
```

This will allow analysis of gross margin by customer and plan.

---

# ServiceTitan Job Processing

The SaaS should eventually separate the concepts of:

```text
ServiceTitan Job
       ↓
Content Generation
       ↓
WordPress Publication
```

Potential entities:

```text
servicetitan_jobs
content_generations
publications
```

Do not collapse everything into a single job record unless inspection of the existing application provides a compelling reason.

We need provenance.

For any published content we should eventually be able to answer:

- Which ServiceTitan job produced it?
- Which source data was used?
- Which prompt/version produced it?
- Which AI model generated it?
- What did the AI operation cost?
- Which WordPress site received it?
- What WordPress post was created/updated?
- When was it published?
- Did publication succeed?
- Was it subsequently updated?

---

# Idempotency

Idempotency is a core requirement.

A ServiceTitan job being fetched multiple times must NOT result in duplicate AI generations, duplicate usage charges, or duplicate WordPress posts.

Design appropriate unique constraints/idempotency keys.

For example, some combination of:

```text
ServiceTitan connection
ServiceTitan tenant
ServiceTitan job ID
operation/version
website
```

may form the identity of an operation.

Determine the correct strategy after inspecting the current workflow.

---

# Background Processing

Do not design the final processing pipeline as one long synchronous HTTP request.

The desired direction is:

```text
Scheduled ServiceTitan sync
        ↓
Discover eligible jobs
        ↓
Persist work
        ↓
Background worker
        ↓
AI generation
        ↓
Content ready
        ↓
WordPress publication
        ↓
Publication result
```

Possible states might include:

```text
discovered
eligible
queued
generating
generated
publishing
published
failed
ignored
```

These are conceptual and may change.

Retries must be safe.

---

# WordPress Communication

We currently favor a **pull-oriented model** for the WordPress connector unless investigation shows a better approach.

Conceptually:

```text
WordPress plugin
      ↓
Authenticate with SaaS
      ↓
Ask for pending content
      ↓
Receive content
      ↓
Create/update WP post
      ↓
Report result
```

This may be more reliable than requiring the SaaS to make inbound requests to arbitrary WordPress installations behind security plugins, Cloudflare, firewalls, etc.

Do not implement this yet without reviewing the existing WordPress integration.

---

# Prompt Versioning

AI prompts should eventually be versioned.

Do not bury important production prompts permanently inside application source code without provenance.

Potential model:

```text
prompt_templates
prompt_versions
```

A generated piece of content should be traceable to the prompt version that created it.

This will allow us to improve prompts without losing historical reproducibility.

---

# Security

Treat the application as a commercial multi-user SaaS from the beginning.

Important requirements:

- Strict User ownership checks
- Never trust a `user_id` supplied by the browser
- Server-side authorization
- Secure cookies/session handling
- CSRF protection where appropriate
- Rate limiting
- API authentication
- WordPress site authentication
- Encrypted sensitive credentials
- Secrets stored in environment/secret management
- No secrets committed to Git
- Stripe webhook signature verification
- Input validation
- Audit logging for important account/billing/integration changes

Assume users will eventually attempt requests against IDs belonging to other users.

Every data access path must enforce ownership.

---

# Initial Database Domains

The current conceptual model contains approximately:

```text
users

websites

plans
plan_prices
subscriptions
payments / invoices
usage_events

servicetitan_connections
servicetitan_jobs

content_generations
publications

prompt_templates
prompt_versions

audit_logs
```

This is NOT permission to immediately create all these tables.

First inspect the current application and then propose the actual PostgreSQL schema.

---

# Preferred Technology Direction

The current preferred direction is:

```text
Frontend/API
TypeScript / modern React stack

Database
PostgreSQL

Hosting
Sevalla

Authentication
Google OAuth

Billing
Stripe

AI
Existing AI integration initially

ServiceTitan
Existing integration adapted to SaaS

WordPress
Existing plugin adapted into connector
```

Do not introduce microservices without a concrete need.

Prefer a modular monolith plus background worker.

---

# FIRST TASK — DO THIS BEFORE MODIFYING CODE

Inspect the entire existing repository.

Produce an architecture assessment covering:

## 1. Repository structure

Identify:

- languages
- frameworks
- packages
- entry points
- build system
- configuration
- deployment assumptions

## 2. ServiceTitan integration

Document:

- authentication
- API endpoints used
- job retrieval
- pagination
- filtering
- eligibility rules
- job updates
- duplicate prevention
- stored identifiers

## 3. AI integration

Document:

- provider(s)
- models
- prompts
- generation workflow
- token tracking
- retries
- errors
- configuration

## 4. WordPress integration

Document:

- plugin structure
- REST endpoints
- cron/scheduling
- content creation
- content updates
- custom post types
- metadata
- authentication
- configuration

## 5. Persistence

Determine:

- what is currently stored
- where it is stored
- WordPress options/meta usage
- files
- external databases
- caches
- transient state

## 6. Security

Identify:

- secrets currently stored
- API credential handling
- authentication mechanisms
- authorization
- exposed endpoints
- obvious security risks

## 7. Reusable code

Categorize existing functionality as:

```text
REUSE AS-IS
ADAPT
MOVE TO SAAS
REPLACE
REMOVE
```

Explain why.

## 8. SaaS migration proposal

After inspection, propose:

- application architecture
- PostgreSQL schema
- repository structure
- background processing approach
- ServiceTitan integration changes
- WordPress integration changes
- Google authentication implementation
- Stripe integration
- usage metering design
- migration sequence

---

# Sevalla Inspection

Also inspect the existing Sevalla environment.

Project:

`ServiceTitan WP Jobs Plugin`

Determine:

- whether Sevalla CLI is installed
- whether authentication is configured
- project ID
- existing applications
- existing databases
- existing services
- environment variables
- deployment configuration
- Git integration

Do NOT display secret values.

Report secret variable names only.

Do NOT create, modify, deploy, delete, or migrate anything yet.

---

# IMPORTANT: STOP POINT

After completing repository and Sevalla inspection:

**STOP.**

Present:

1. Current architecture
2. Problems/risks discovered
3. Reusable components
4. Proposed target architecture
5. Proposed PostgreSQL schema
6. Proposed implementation phases
7. Decisions/questions requiring owner approval

Do not begin the migration until this proposal has been reviewed.

The immediate objective is to understand what exists and establish the correct architecture—not to generate large amounts of new code prematurely.