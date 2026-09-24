/** @fumoca/storage: storage provider interface and built-in providers. See SPECS.md §8. */
export {
  createSheet,
  createWorkbook,
  FILE_EXTENSION,
  FILE_FORMAT,
  FILE_VERSION,
  parseWorkbook,
  type Sheet,
  serializeWorkbook,
  setCell,
  type Workbook,
  WorkbookFormatError,
} from "./workbook";
