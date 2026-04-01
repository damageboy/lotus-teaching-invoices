import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { Invoice, AppConfig } from '../types';

const s = StyleSheet.create({
  page: { padding: 48, fontFamily: 'Helvetica', fontSize: 10, color: '#111' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 32 },
  addressBlock: { flex: 1 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  addressText: { fontSize: 9, color: '#444', lineHeight: 1.5 },
  section: { marginBottom: 20 },
  label: { fontSize: 8, color: '#888', textTransform: 'uppercase', marginBottom: 2 },
  value: { fontSize: 10 },
  table: { marginTop: 16 },
  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: '#ddd',
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderColor: '#eee',
  },
  col: { flex: 1, fontSize: 9 },
  colRight: { flex: 1, fontSize: 9, textAlign: 'right' },
  total: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
    fontSize: 11,
    fontWeight: 'bold',
  },
  footer: { marginTop: 32, paddingTop: 12, borderTopWidth: 0.5, borderColor: '#ddd' },
  footerLabel: { fontSize: 7, color: '#aaa', textTransform: 'uppercase', marginBottom: 1 },
  footerValue: { fontSize: 8, color: '#555', marginBottom: 6 },
  footerRow: { flexDirection: 'row', gap: 32 },
});

interface Props {
  invoice: Invoice;
  config: AppConfig;
}

export function InvoiceDocument({ invoice, config }: Props) {
  const { teacher } = config;
  const studio = config.studios[invoice.studioName];
  const studioDisplay = studio?.fullName || invoice.studioName;
  const studioAddress = studio?.address || '';

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <View style={s.headerRow}>
          <View style={s.addressBlock}>
            <Text style={s.title}>{teacher.name || 'Invoice'}</Text>
            {teacher.address ? <Text style={s.addressText}>{teacher.address}</Text> : null}
            {teacher.taxNumber ? (
              <Text style={s.addressText}>Tax no.: {teacher.taxNumber}</Text>
            ) : null}
            {teacher.bankDetails.accountOwner ||
            teacher.bankDetails.iban ||
            teacher.bankDetails.bic ? (
              <View style={[s.footerRow, { marginTop: 8 }]}>
                {teacher.bankDetails.accountOwner ? (
                  <View>
                    <Text style={s.footerLabel}>Account owner</Text>
                    <Text style={s.footerValue}>{teacher.bankDetails.accountOwner}</Text>
                  </View>
                ) : null}
                {teacher.bankDetails.iban ? (
                  <View>
                    <Text style={s.footerLabel}>IBAN</Text>
                    <Text style={s.footerValue}>{teacher.bankDetails.iban}</Text>
                  </View>
                ) : null}
                {teacher.bankDetails.bic ? (
                  <View>
                    <Text style={s.footerLabel}>BIC</Text>
                    <Text style={s.footerValue}>{teacher.bankDetails.bic}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', marginBottom: 2 }}>
                {studioDisplay}
              </Text>
              {studioAddress ? <Text style={s.addressText}>{studioAddress}</Text> : null}
            </View>
          </View>
        </View>

        {/* Invoice number — only for finalized invoices */}
        {invoice.invoiceNumber ? (
          <View style={s.section}>
            <Text style={s.label}>Invoice No.</Text>
            <Text style={{ ...s.value, fontWeight: 'bold' }}>{invoice.invoiceNumber}</Text>
          </View>
        ) : null}

        {/* Invoice period */}
        <View style={s.section}>
          <Text style={s.label}>Invoice period</Text>
          <Text style={s.value}>
            {invoice.invoicePeriod.from} — {invoice.invoicePeriod.to}
          </Text>
        </View>

        {/* Class table */}
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
              <Text style={s.col}>
                {item.startTime}–{item.endTime}
              </Text>
              <Text style={s.col}>
                {item.location ? `${item.location} / ${item.classType}` : item.classType}
              </Text>
              <Text style={s.colRight}>{item.studentCount}</Text>
              <Text style={s.colRight}>{item.rateApplied}</Text>
              <Text style={s.colRight}>{item.lineTotal}</Text>
            </View>
          ))}
        </View>

        {/* Total */}
        <View style={s.total}>
          <Text>Total: € {invoice.totalAmount}</Text>
        </View>

        {/* Tax note */}
        <View style={s.footer}>
          <Text style={s.footerValue}>
            Als Kleinunternehmer im Sinne von § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
