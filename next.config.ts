import { NextConfig } from 'next'

export default {
  poweredByHeader: false,

  turbopack: {
    rules: {
      '*.po': {
        loaders: ['@lingui/loader'],
        as: '*.js',
      },
    },
  },

  webpack: (config) => {
    config.module.rules.push({
      test: /\.po$/,
      use: {
        loader: '@lingui/loader',
      },
    })

    return config
  },
} satisfies NextConfig
