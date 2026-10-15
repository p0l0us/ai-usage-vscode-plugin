#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { runTests } = require('../service/scripts/run-tests');
runTests({ root: path.resolve(__dirname, '..'), buildScript: 'compile', directories: ['test', 'service/test', 'bridge/test'] });
