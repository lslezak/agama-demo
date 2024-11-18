const path = require("path");
const fs = require("fs");
const webpack = require("webpack");

module.exports = {
  target: "node",
  entry: { agama_dump: "./src/agama_dump.ts" },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  devtool: "source-map",
  // optimization: {
  //   splitChunks: {
  //     cacheGroups: {
  //       vendor: {
  //         test: /[\\/]node_modules[\\/]/,
  //         name: "vendor",
  //         chunks: "all",
  //       },
  //     },
  //   },
  // },
  watchOptions: {
    // wait a little bit when saving multiple files
    aggregateTimeout: 50,
    ignored: /node_modules/,
  },
  plugins: [
    // prepend a hashbang at the beginning of the generated file
    new webpack.BannerPlugin({
      banner: "#! /usr/bin/env node",
      raw: true,
      test: "agama_dump.js",
    }),
    // make the test JS files executable
    function () {
      this.hooks.done.tap("Change permissions", (data) => {
        Object.keys(data.compilation.assets).forEach((file) => {
          if (file === "agama_dump.js") {
            fs.chmodSync(`${__dirname}/dist/${file}`, 0o755);
          }
        });
      });
    },
  ],
};
