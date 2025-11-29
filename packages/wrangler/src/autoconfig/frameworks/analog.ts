import { brandColor, dim } from "@cloudflare/cli/colors";
import { spinner } from "@cloudflare/cli/interactive";
import * as recast from "recast";
import * as typescriptParser from "recast/parsers/typescript";
import { getPackageManager } from "../../package-manager";
import { transformFile } from "../c3-vendor/codemod";
import { installPackages } from "../c3-vendor/packages";
import { Framework } from ".";
import type { ConfigurationOptions, ConfigurationResults } from ".";
import type { Program } from "esprima";

export class Analog extends Framework {
	async configure({
		workerName,
		outputDir,
		dryRun,
	}: ConfigurationOptions): Promise<ConfigurationResults> {
		if (!dryRun) {
			const packageManager = await getPackageManager();

			// Fix hoisting issues with pnpm, yarn and bun
			if (
				packageManager.type === "pnpm" ||
				packageManager.type === "yarn" ||
				packageManager.type === "bun"
			) {
				const packages = [
					"nitropack",
					"h3",
					"@ngtools/webpack",
					"@angular-devkit/build-angular",
				];

				await installPackages(packages, {
					dev: true,
					startText: `Installing ${packages.join(", ")}`,
					doneText: `${brandColor("installed")} ${dim(`via \`${packageManager.type} install\``)}`,
				});
			}

			updateViteConfig();
		}
		return {
			wranglerConfig: {
				name: workerName,
				main: "./dist/server/server.mjs",
				assets: {
					binding: "ASSETS",
					directory: outputDir,
				},
			},
		};
	}
}

function updateViteConfig() {
	const b = recast.types.builders;
	const s = spinner();

	const configFile = "vite.config.ts";
	s.start(`Updating \`${configFile}\``);

	transformFile(configFile, {
		visitProgram(n) {
			const lastImportIndex = n.node.body.findLastIndex(
				(t) => t.type === "ImportDeclaration"
			);
			const lastImport = n.get("body", lastImportIndex);

			const astNodes = (
				recast.parse(
					`
						import { Nitro } from 'nitropack';

						const devBindingsModule = async (nitro: Nitro) => {
							if (nitro.options.dev) {
									nitro.options.plugins.push('./src/dev-bindings.ts');
							}
						};
					`,
					{ parser: typescriptParser }
				).program as Program
			).body;

			lastImport.insertAfter(...astNodes);

			return this.traverse(n);
		},
		visitCallExpression(n) {
			const callee = n.node.callee as recast.types.namedTypes.Identifier;
			if (callee.name === "analog") {
				const pluginArguments = b.objectProperty(
					b.identifier("nitro"),
					b.objectExpression([
						b.objectProperty(
							b.identifier("preset"),
							b.stringLiteral("cloudflare_module")
						),
						b.objectProperty(
							b.identifier("modules"),
							b.arrayExpression([b.identifier("devBindingsModule")])
						),
					])
				);

				n.node.arguments = [b.objectExpression([pluginArguments])];
			}

			return this.traverse(n);
		},
	});

	s.stop(`${brandColor(`updated`)} ${dim(`\`${configFile}\``)}`);
}
