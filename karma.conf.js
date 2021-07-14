module.exports = function (config) {
  config.set({
    frameworks: ['mocha', 'karma-typescript'],
    files: [
      'src/lib/**/*.ts',
      'src/proto/**/*.ts',
      'src/tests/browser/*.spec.ts',
    ],
    preprocessors: {
      '**/*.ts': ['karma-typescript'],
    },
    plugins: [
      require('karma-mocha'),
      require('karma-typescript'),
      require('karma-chrome-launcher'),
    ],
    logLevel: config.LOG_DEBUG,
    reporters: ['progress', 'karma-typescript'],
    browsers: ['Chromium'],
    singleRun: true,
    karmaTypescriptConfig: {
      bundlerOptions: {
        entrypoints: /src\/tests\/browser\/.*\.spec\.ts$/,
      },
      tsconfig: './tsconfig.karma.json',
      coverageOptions: {
        instrumentation: false,
      },
    },
  });
};
