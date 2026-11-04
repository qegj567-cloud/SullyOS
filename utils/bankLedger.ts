import type { BankTransaction } from '../types';
import { formatMoney, roundMoney, sumMoney } from './format';

export const transactionType = (tx: Pick<BankTransaction, 'type'>) => tx.type === 'income' ? 'income' : 'expense';
export const isExpense = (tx: Pick<BankTransaction, 'type'>) => transactionType(tx) === 'expense';
export function ledgerTotals(transactions: BankTransaction[]) {
    const expense = sumMoney(transactions.filter(isExpense).map(tx => tx.amount));
    const income = sumMoney(transactions.filter(tx => !isExpense(tx)).map(tx => tx.amount));
    return { expense, income, balance: roundMoney(income - expense) };
}
export function parseLedgerAmount(value: string): number | null {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER / 100 ? roundMoney(amount) : null;
}
const csvText = (text: string) => `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
export function formatLedgerCsv(transactions: BankTransaction[], categoryLabel: (tx: BankTransaction) => string = tx => tx.category || '其他'): string {
    const rows = [...transactions].sort((a, b) => b.timestamp - a.timestamp).map(tx => [
        csvText(tx.dateStr), csvText(new Date(tx.timestamp).toLocaleTimeString('zh-CN', {hour12: false})),
        isExpense(tx) ? '支出' : '收入', formatMoney(tx.amount), csvText(tx.note || ''), csvText(isExpense(tx) ? categoryLabel(tx) : '收入'),
    ].join(','));
    return '\uFEFF日期,时间,类型,金额,备注,分类\r\n' + rows.join('\r\n');
}
