import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts' },
    // Dual, ESM first. Measured by `claude · tynn` on fancy-pty and it applies
    // identically here: genie2's built ESM bundle leaves packages external, and
    // Node refuses a named import from a CJS package with getter-defined
    // exports. CJS is carried for everyone else and costs nothing.
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: 'node',
    // Node builtins stay external, and there is nothing else to externalise:
    // this package has no runtime dependencies at all, which is the point.
    external: [/^node:/],
    treeshake: true,
});
