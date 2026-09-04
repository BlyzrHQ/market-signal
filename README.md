# Market Signal — direct Trigger CLI

Install the CLI, configure your company's Trigger environment API key, and run
research tasks directly in Trigger. No Market Signal website login, workspace
credential, or customer quota is involved.

**[Installation and command instructions](docs/direct-trigger-cli.md)**

```powershell
marketsignal-trigger configure
marketsignal-trigger doctor
marketsignal-trigger report "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>"
marketsignal-trigger result "<run-id>"
```

Replace every placeholder with your own input. No test store is prefilled.
The comparison count means priced product/rival pairs, not catalog size.
JSON includes comparisons, rivals, evidence, quality checks, and limitations.

The operator first deploys the direct tasks and sets research-provider
credentials in the company Trigger environment. Colleagues only need the
installed executable and their Trigger environment key after that setup.
Download the matching binaries from the **Direct Trigger CLI** GitHub Actions
artifact for the reviewed commit, or get the ZIP from your company operator.

This branch is independent of the website/customer CLI workflow. The existing
website source remains in the repository but is not used by this executable.
See the guide for the precise validation and deployment boundary; a successful
local test is not proof that the new tasks are installed in your project.

Developer checks (not required on a colleague's machine): `npm ci`,
`npm run test:open-source`, `npm test`, and `go -C cli test ./...`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for repository development rules.
