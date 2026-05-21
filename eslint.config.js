import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // example-app is a peer subproject with its own lint surface (D-006);
    // ignore it from the toolkit's lint so root `npm run lint` doesn't
    // try to parse TSX/decorators/Next.js syntax from the subproject.
    ignores: ["dist/**", "node_modules/**", "fixtures/**", "example-app/**"],
  },
];
