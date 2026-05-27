function resolveWeakFallbackPlugin() {
  return {
    name: 'resolve-weak-fallback',
    configureWebpack(_config, isServer) {
      if (!isServer) {
        return {};
      }

      return {
        plugins: [
          {
            apply(compiler) {
              const { Compilation, sources } = compiler.webpack;

              compiler.hooks.thisCompilation.tap('resolve-weak-fallback', (compilation) => {
                compilation.hooks.processAssets.tap(
                  {
                    name: 'resolve-weak-fallback',
                    stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
                  },
                  () => {
                    for (const assetName of Object.keys(compilation.assets)) {
                      if (!assetName.endsWith('.js')) continue;

                      const asset = compilation.getAsset(assetName);
                      if (!asset) continue;

                      const source = asset.source.source().toString();
                      if (!source.includes('require.resolveWeak(')) {
                        continue;
                      }

                      let patchedSource = source;
                      if (patchedSource.includes('prism-include-languages')) {
                        patchedSource = patchedSource.replace(
                          /\/\* harmony default export \*\/ const __WEBPACK_DEFAULT_EXPORT__ = \(\[require\([^;]+;\n/,
                          '/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = ([]);\n'
                        );
                      }
                      patchedSource = patchedSource.replace(/require\.resolveWeak\("([^"]+)"\)/g, 'undefined');

                      compilation.updateAsset(assetName, new sources.RawSource(patchedSource));
                    }
                  }
                );
              });
            },
          },
        ],
      };
    },
  };
}

module.exports = resolveWeakFallbackPlugin;
