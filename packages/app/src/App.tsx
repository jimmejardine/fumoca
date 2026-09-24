import { AppShell, Title } from "@mantine/core";
import { RevoGrid } from "@revolist/react-datagrid";

const COLUMN_COUNT = 10;
const ROW_COUNT = 100;

const columns = Array.from({ length: COLUMN_COUNT }, (_, i) => {
  const name = String.fromCharCode(65 + i);
  return { prop: name, name };
});
const source = Array.from({ length: ROW_COUNT }, () => ({}));

export function App() {
  return (
    <AppShell header={{ height: 48 }} padding={0}>
      <AppShell.Header px="md" style={{ display: "flex", alignItems: "center" }}>
        <Title order={4}>fumoca</Title>
      </AppShell.Header>
      <AppShell.Main style={{ height: "100dvh" }}>
        <RevoGrid columns={columns} source={source} range rowHeaders style={{ height: "100%" }} />
      </AppShell.Main>
    </AppShell>
  );
}
