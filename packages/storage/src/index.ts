/** @fumoca/storage: storage provider interface and built-in providers. See SPECS.md §8. */

export {
  hasNoPeriods,
  lastUsedRow,
  type SeriesIssues,
  seriesIssues,
  sortSeriesSheet,
  suggestPeriod,
} from "./series";
export {
  addSeriesColumn,
  addSheet,
  columnNameError,
  createSeriesSheet,
  createSheet,
  createWorkbook,
  FILE_EXTENSION,
  FILE_FORMAT,
  FILE_VERSION,
  nextSheetName,
  PERIOD_COLUMN,
  parseWorkbook,
  renameSeriesColumn,
  SERIES_TYPES,
  type SeriesSettings,
  type SeriesType,
  type Sheet,
  serializeWorkbook,
  setCell,
  setSeriesSettings,
  type Workbook,
  WorkbookFormatError,
} from "./workbook";
