# Agent Instructions

## Spec-First Rule

Before changing product behavior, write or update the relevant Gherkin feature spec under `spec/`.

Use an existing `.feature` file when the change extends an existing capability. Create a new `.feature` file when the change introduces a durable new capability.

Do not implement product behavior until the expected behavior is captured in a `.feature` scenario.

## Test Rule

Every behavior change must include tests that verify the relevant `.feature` scenarios.

Tests do not need to execute `.feature` files directly, but they must prove the same behavior described by the scenarios.

A task is not done until:

- the feature spec describes the expected behavior,
- the implementation matches the spec,
- tests verify the behavior,
- the project verification command passes.

## Verification

Run the smallest meaningful checks for the changed surface.

Before submitting for review, run the repository's documented typecheck, test, build, and E2E commands that apply to the change.

## Review Standard

A PR should be sent back for changes when product behavior changed without a `.feature` update, tests do not verify the changed behavior, implementation contradicts the feature spec, verification commands fail, or the change bypasses project architecture without an accepted decision.
