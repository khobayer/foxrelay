# Contributing

Thanks for helping. A few ground rules keep the relay dependable for people who leave it running overnight.

## Principles

- **Zero dependencies.** Node built-ins only. Anyone should be able to clone and run it.
- **Never repeat work.** Any change to resume or retry logic must keep the rule: a task that reached the model is continued, never re-sent.
- **Safe by default.** New features must not widen what the engineer can do without the user opting in.
- **Every failure path has a test.** If you fix a bug, add a scenario to `test/run-tests.mjs` that fails without your fix.

## Running the tests

```bash
node test/run-tests.mjs
```

The tests use a fake `claude` (`test/stub-claude.mjs`) driven by a scenario file, so they make no API calls and cost nothing. They need a Unix shell, `git` and `python3` (for the pseudo-terminal test). On Windows, use WSL.

To add a scenario, script what the fake planner (`opus`) and engineer (`sonnet`) return, step by step. Look at the existing tests for internet drops, crashes and usage limits.

## Pull requests

- Keep them small and focused, with a short description of the problem and the fix.
- Update `README.md` and `CHANGELOG.md` if behaviour or config changes.
- Real runs against Claude are welcome as evidence, but the scenario tests must pass.
