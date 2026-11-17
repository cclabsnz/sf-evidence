import type { Config } from 'jest';
import base from '../../jest.base.ts';

const config: Config = { ...base, roots: ['<rootDir>/test'] };

export default config;
