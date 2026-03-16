# ADR: ESLint with Recommended Rules

## Context
We chose ESLint as the linting tool for this project, configured with recommended rules and strict TypeScript settings.

### 1. Recommended Rules
- Using ESLint's recommended rules ensures adherence to widely accepted best practices.
- Stylistic rules help maintain a consistent code style across the project.

### 2. TypeScript-ESLint Strict Mode
- Enabling strict mode aligns with future TypeScript versions where strict mode will be the default.
- This ensures type safety and reduces potential bugs.

### 3. Forward-Looking Configuration
- The chosen configuration is designed to be compatible with future updates to TypeScript and ESLint.
- This minimizes the need for frequent reconfiguration.