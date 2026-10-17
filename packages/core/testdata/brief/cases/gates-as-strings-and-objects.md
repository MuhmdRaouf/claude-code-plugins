---
title: t
gates:
  - npm test
  - run: npm run e2e
    timeout: 1h
  - { run: make lint }
---
Body.
