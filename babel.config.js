const config = {
  presets: [
    'next/babel',
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
  ],
  plugins: ['@lingui/babel-plugin-lingui-macro'],
}

export default config
