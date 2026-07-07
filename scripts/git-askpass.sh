#!/bin/sh
case "$1" in
  Username*) echo "${GIT_USERNAME:-x-access-token}" ;;
  Password*) echo "${GIT_PASSWORD:-}" ;;
  *) echo "" ;;
esac
