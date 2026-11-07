#!/bin/sh
# Display once on interactive SSH login; remote commands and transfers stay quiet.
case $- in
  *i*)
    if [ -n "${SSH_CONNECTION:-}" ] && [ -t 1 ] && [ -x /usr/local/bin/sp-welcome ]; then
      /usr/local/bin/sp-welcome
    fi
    ;;
esac
