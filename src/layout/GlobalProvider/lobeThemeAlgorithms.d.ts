/**
 * `@lobehub/ui` publishes its theme algorithms through the `./es/*` subpath export but
 * ships no declaration file for them. `brandPrimaryTheme` composes them with a
 * brand-primary patch, so both entry points are typed here against antd's contract.
 */
declare module '@lobehub/ui/es/styles/theme/algorithms/lightAlgorithm' {
  import type { MappingAlgorithm } from 'antd';

  export const lightAlgorithm: MappingAlgorithm;
}

declare module '@lobehub/ui/es/styles/theme/algorithms/darkAlgorithm' {
  import type { MappingAlgorithm } from 'antd';

  export const darkAlgorithm: MappingAlgorithm;
}
