import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { Invoice, AppConfig } from '../types';

const s = StyleSheet.create({
  page:      { padding: 48, fontFamily: 'Helvetica', fontSize: 10, color: '#111' },
  header:    { marginBottom: 32 },
  title:     { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  subtitle:  { fontSize: 11, color: '#555' },
  section:   { marginBottom: 20 },
  label:     { fontSize: 8, color: '#888', textTransform: 'uppercase', marginBottom: 2 },
  value:     { fontSize: 10 },
  table:     { marginTop: 16 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#ddd', paddingBottom: 4, marginBottom: 4 },
  tableRow:  { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.5, borderColor: '#eee' },
  col:       { flex: 1, fontSize: 9 },
  colRight:  { flex: 1, fontSize: 9, textAlign: 'right' },
  total:     { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, fontSize: 11, fontWeight: 'bold' },
});

interface Props {
  invoice: Invoice;
  config: AppConfig;
}

export function InvoiceDocument({ invoice, config }: Props) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>{config.teacherName || 'Invoice'}</Text>
          <Text style={s.subtitle}>{invoice.studioName}</Text>
        </View>

        <View style={s.section}>
          <Text style={s.label}>Invoice period</Text>
          <Text style={s.value}>{invoice.invoicePeriod.from} — {invoice.invoicePeriod.to}</Text>
        </View>

        <View style={s.table}>
          <View style={s.tableHead}>
            <Text style={s.col}>Date</Text>
            <Text style={s.col}>Time</Text>
            <Text style={s.col}>Class</Text>
            <Text style={s.colRight}>Students</Text>
            <Text style={s.colRight}>Rate (€)</Text>
            <Text style={s.colRight}>Total (€)</Text>
          </View>
          {invoice.classes.map((item, i) => (
            <View key={i} style={s.tableRow}>
              <Text style={s.col}>{item.date}</Text>
              <Text style={s.col}>{item.startTime}–{item.endTime}</Text>
              <Text style={s.col}>{item.classType}</Text>
              <Text style={s.colRight}>{item.studentCount}</Text>
              <Text style={s.colRight}>{item.rateApplied}</Text>
              <Text style={s.colRight}>{item.lineTotal}</Text>
            </View>
          ))}
        </View>

        <View style={s.total}>
          <Text>Total: €{invoice.totalAmount}</Text>
        </View>
      </Page>
    </Document>
  );
}
