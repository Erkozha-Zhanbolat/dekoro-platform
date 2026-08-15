import { StyleSheet } from "@react-pdf/renderer";
import { INVOICE_COL, INVOICE_PAGE, INVOICE_TYPE } from "./constants";

export const invoiceStyles = StyleSheet.create({
  page: {
    fontFamily: "Roboto",
    fontSize: INVOICE_TYPE.bodyFont,
    paddingTop: INVOICE_PAGE.marginTop,
    paddingBottom: INVOICE_PAGE.marginBottom,
    paddingHorizontal: INVOICE_PAGE.marginX,
    color: "#000000",
  },
  notice: {
    fontSize: INVOICE_TYPE.noticeFont,
    lineHeight: INVOICE_TYPE.noticeLineHeight,
    textAlign: "center",
    marginBottom: 4,
  },
  noticeLine: {
    marginBottom: 0.5,
  },
  paymentTitle: {
    fontSize: 7,
    fontWeight: 700,
    textAlign: "center",
    marginBottom: 2,
  },
  paymentBox: {
    borderWidth: INVOICE_TYPE.tableBorder,
    borderColor: "#000000",
    marginBottom: 5,
  },
  paymentRow: {
    flexDirection: "row",
    borderBottomWidth: INVOICE_TYPE.tableBorder,
    borderBottomColor: "#000000",
  },
  paymentRowLast: {
    flexDirection: "row",
  },
  bankCell: {
    paddingVertical: INVOICE_TYPE.bankPadY,
    paddingHorizontal: INVOICE_TYPE.bankPadX,
    borderRightWidth: INVOICE_TYPE.tableBorder,
    borderRightColor: "#000000",
    justifyContent: "center",
  },
  bankCellLast: {
    paddingVertical: INVOICE_TYPE.bankPadY,
    paddingHorizontal: INVOICE_TYPE.bankPadX,
    justifyContent: "center",
  },
  bankLabel: {
    fontSize: INVOICE_TYPE.bankLabelFont,
    lineHeight: 1.1,
    marginBottom: 0.5,
  },
  bankValue: {
    fontSize: INVOICE_TYPE.bankValueFont,
    fontWeight: 700,
    lineHeight: 1.12,
  },
  title: {
    fontSize: INVOICE_TYPE.titleFont,
    fontWeight: 700,
    textAlign: "center",
    marginTop: 2,
    marginBottom: 2,
  },
  titleRule: {
    borderBottomWidth: 1,
    borderBottomColor: "#000000",
    marginBottom: 4,
  },
  partyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 1.5,
  },
  partyLabel: {
    width: INVOICE_TYPE.partyLabelWidth,
    fontSize: 8.5,
    fontWeight: 700,
    lineHeight: INVOICE_TYPE.bodyLineHeight,
  },
  partyValue: {
    flex: 1,
    fontSize: INVOICE_TYPE.bodyFont,
    lineHeight: INVOICE_TYPE.bodyLineHeight,
  },
  partiesWrap: {
    marginBottom: 4,
  },
  tableHeader: {
    flexDirection: "row",
    borderWidth: INVOICE_TYPE.tableBorder,
    borderColor: "#000000",
    backgroundColor: "#ffffff",
  },
  tableRow: {
    flexDirection: "row",
    borderLeftWidth: INVOICE_TYPE.tableBorder,
    borderRightWidth: INVOICE_TYPE.tableBorder,
    borderBottomWidth: INVOICE_TYPE.tableBorder,
    borderColor: "#000000",
  },
  th: {
    fontSize: INVOICE_TYPE.tableHeaderFont,
    fontWeight: 700,
    paddingVertical: INVOICE_TYPE.tablePadY,
    paddingHorizontal: INVOICE_TYPE.tablePadX,
    textAlign: "center",
    borderRightWidth: INVOICE_TYPE.tableBorder,
    borderRightColor: "#000000",
  },
  td: {
    fontSize: INVOICE_TYPE.tableFont,
    lineHeight: INVOICE_TYPE.tableLineHeight,
    paddingVertical: INVOICE_TYPE.tablePadY,
    paddingHorizontal: INVOICE_TYPE.tablePadX,
    borderRightWidth: INVOICE_TYPE.tableBorder,
    borderRightColor: "#000000",
  },
  tdLast: {
    fontSize: INVOICE_TYPE.tableFont,
    lineHeight: INVOICE_TYPE.tableLineHeight,
    paddingVertical: INVOICE_TYPE.tablePadY,
    paddingHorizontal: INVOICE_TYPE.tablePadX,
  },
  thLast: {
    fontSize: INVOICE_TYPE.tableHeaderFont,
    fontWeight: 700,
    paddingVertical: INVOICE_TYPE.tablePadY,
    paddingHorizontal: INVOICE_TYPE.tablePadX,
    textAlign: "center",
  },
  cNo: { width: INVOICE_COL.no, textAlign: "center" },
  cSku: { width: INVOICE_COL.sku, textAlign: "center" },
  cName: { width: INVOICE_COL.name, textAlign: "left" },
  cQty: { width: INVOICE_COL.qty, textAlign: "right" },
  cUnit: { width: INVOICE_COL.unit, textAlign: "center" },
  cPrice: { width: INVOICE_COL.price, textAlign: "right" },
  cSum: { width: INVOICE_COL.sum, textAlign: "right" },
  footer: {
    marginTop: 4,
  },
  totalsWrap: {
    alignItems: "flex-end",
    marginBottom: 3,
  },
  totalLine: {
    flexDirection: "row",
    width: 250,
    marginBottom: 1,
  },
  totalLabel: {
    width: 150,
    textAlign: "right",
    paddingRight: 8,
    fontSize: 8,
  },
  totalValue: {
    width: 100,
    textAlign: "right",
    fontSize: 8,
  },
  totalStrong: {
    fontWeight: 700,
  },
  totalsRule: {
    width: 250,
    borderBottomWidth: 0.6,
    borderBottomColor: "#000000",
    marginVertical: 1.5,
  },
  summary: {
    fontSize: 8,
    marginBottom: 2,
    lineHeight: 1.12,
  },
  summaryStrong: {
    fontWeight: 700,
    fontSize: 8.5,
    lineHeight: 1.15,
    marginBottom: 2,
  },
  signRule: {
    borderBottomWidth: 0.6,
    borderBottomColor: "#000000",
    marginTop: 6,
    marginBottom: 5,
  },
  signLabel: {
    fontSize: 8.5,
    fontWeight: 700,
    marginBottom: 3,
  },
  signRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  stampSlot: {
    width: INVOICE_TYPE.stampSize + 8,
    height: INVOICE_TYPE.stampSize,
    marginRight: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  stampImage: {
    width: INVOICE_TYPE.stampSize,
    height: INVOICE_TYPE.stampSize,
    objectFit: "contain",
  },
  signSlot: {
    width: INVOICE_TYPE.signatureWidth + 8,
    marginRight: 12,
    alignItems: "center",
  },
  signatureImage: {
    width: INVOICE_TYPE.signatureWidth,
    height: INVOICE_TYPE.signatureHeight,
    objectFit: "contain",
  },
  signLine: {
    width: INVOICE_TYPE.signatureWidth,
    marginTop: INVOICE_TYPE.signatureHeight - 2,
    borderBottomWidth: 0.5,
    borderBottomColor: "#000000",
  },
  directorName: {
    fontSize: 7.5,
    textAlign: "center",
    marginTop: 2,
  },
  issuedDate: {
    fontSize: 8,
    marginBottom: 2,
  },
});
