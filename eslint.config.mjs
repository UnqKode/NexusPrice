// eslint-config-next 16 ships native flat configs at
// `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`.
// This file previously went through `FlatCompat`'s `compat.extends("next/...")`
// - the eslint-config-next 15 style - which crashes outright against v16
// ("TypeError: Converting circular structure to JSON" while eslintrc tries to
// serialize the now-flat plugin objects), so `npm run lint` failed to run at
// all rather than reporting lint errors. Importing the flat configs directly
// is what the bundled Next 16 docs prescribe:
// node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md
//
// Note also that `next lint` was removed in Next 16 - `npm run lint` invokes
// the ESLint CLI directly, which is why this config has to stand on its own.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Restates eslint-config-next's own default ignores, which are replaced
  // (not merged) once this config declares any of its own.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
