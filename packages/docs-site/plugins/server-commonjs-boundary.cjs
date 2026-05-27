function serverCommonjsBoundaryPlugin() {
  return {
    name: 'server-commonjs-boundary',
    configureWebpack(_config, isServer) {
      if (!isServer) {
        return {};
      }

      return {
        plugins: [
          {
            apply(compiler) {
              compiler.hooks.afterEmit.tap('server-commonjs-boundary', (compilation) => {
                const outputPath = compilation.outputOptions.path;
                if (!outputPath) {
                  return;
                }

                const fs = compiler.outputFileSystem;
                const boundaryPath = `${outputPath}/package.json`;
                const content = JSON.stringify({ type: 'commonjs' }, null, 2);

                if (typeof fs.mkdirSync === 'function') {
                  fs.mkdirSync(outputPath, { recursive: true });
                }
                fs.writeFileSync(boundaryPath, content);
              });
            },
          },
        ],
      };
    },
  };
}

module.exports = serverCommonjsBoundaryPlugin;
