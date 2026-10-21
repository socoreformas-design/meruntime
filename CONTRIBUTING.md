# Contributing to Me Runtime

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Before you start

- **Bugs and ideas:** open a GitHub issue. Please include your OS, Node version and `meruntime doctor` output.
- **Security issues:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first so we can agree on the approach.

## Contributor License Agreement (CLA)

Me Runtime is distributed under the [FSL-1.1-MIT](LICENSE.md) license. To keep the ability to license the project in the future, **every contributor must accept the [Contributor License Agreement](CLA.md) before a pull request can be merged.**

To accept it, add this sentence to your first pull request description:

> I have read the Me Runtime CLA (CLA.md) and I agree to its terms for this and all my future contributions.

## Development

```sh
npm ci
npm test
npm run build
```

- Keep pull requests small and focused, and add tests for behaviour changes.
- Do not commit secrets, tokens, real IBANs or personal data. Use the fictitious values already used in tests (for example `ES00 DEMO 0000 0000 0000 0001`).
- Decisions must stay deterministic: no network calls or model calls inside policy evaluation.
