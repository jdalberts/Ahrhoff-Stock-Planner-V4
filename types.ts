export interface Item {
  id: string;
  skuCode: string;
  name: string;
  category: 'Clex' | 'Browser' | 'Segawean' | 'Other';
  packSize: number;
  leadTimeDays: number;
  moq: number;
  costPerUnit: number;
  notes?: string;
  shelfLifeDays?: number;
}

export interface InventoryLot {
  id: string;
  itemId: string;
  lotNumber: string;
  expiryDate: string | null;
  quantityRemaining: number;
  receivedDate: string | null;
  quantityReceived?: number | null;
  status: 'available' | 'expired' | 'damaged';
  notes?: string;
}

export interface StockCountEntry {
  id: string;
  date: string;
  lotId: string;
  countedQty: number;
  reason: 'adjustment' | 'damage' | 'correction' | 'routine';
  notes?: string;
}

export interface SalesHistory {
  id: string;
  itemId: string;
  month: string;
  quantitySold: number;
}

export interface Settings {
  defaultLeadTimeDays: number;
  safetyStockDays: number;
  reviewPeriodDays: number;
  lowStockDaysCoverThreshold: number;
  expiryWarningDays: number;
  notificationCooldownHours: number;
  currencySymbol: string;
  whatsappMode: 'disabled' | 'clickToWhatsApp' | 'webhookAPI';
  whatsappNumber: string;
  whatsappRecipients: string[];
  webhookUrl?: string;
  webhookApiKey?: string;
  forecastMethod: 'simpleAverage6Months' | 'weightedAverage';
  weights: number[];
  lowStockRule: 'belowDaysCover' | 'belowReorderPoint';
}

export interface InventoryAlert {
  id: string;
  createdAt: string;
  itemId: string;
  type: 'lowStock' | 'expiry';
  message: string;
  status: 'pending' | 'sent' | 'dismissed';
  lastSentAt?: string;
  recipientsSnapshot?: string[];
}

export interface ItemPlanningView {
  item: Item;
  lots: InventoryLot[];
  sales: SalesHistory[];
  availableStock: number;
  inTransitStock: number;
  avgMonthlyDemand: number;
  dailyDemand: number;
  safetyStock: number;
  reorderPoint: number;
  suggestedOrderQty: number;
  freshnessCapApplied?: boolean;
  freshnessCapQty?: number;
  projectedDaysCoverAfterOrder?: number;
  daysCover: number;
  lowStockFlag: boolean;
  expiringSoonLots: InventoryLot[];
}

export interface TransitContainerLine {
  itemId: string;
  itemName: string;
  pallets: number;
  quantityKg: number;
}

export type TransitContainerStatus = 'on_po' | 'on_the_way' | 'received';

export interface ShippingPosition {
  lat: number;
  lon: number;
}

export type ShippingStatus = 'At sea' | 'In port' | 'Arrived' | 'Unknown';

export interface TransitContainer {
  id: string;
  orderNumber: string;
  shipName: string;
  eta: string;
  status: TransitContainerStatus;
  source: 'manual' | 'builder';
  lines: TransitContainerLine[];
  containerNumber?: string;
  vesselIMO?: string;
  vesselName?: string;
  destinationPort?: string;
  etaIso?: string;
  lastPosition?: ShippingPosition;
  lastUpdatedIso?: string;
  shippingStatus?: ShippingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SalesTransaction {
  id?: string;
  product: string;
  customer: string;
  date: string;
  qty: number;
  pricePerKg: number;
}

export interface NormalizedTransaction {
  customerName: string;
  transactionDate: string;
  transactionType: string;
  number: string;
  productService: string;
  memo: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface ImportMetadata {
  sourceFileName: string;
  sheetName: string;
  formatDetected: 'inventoryLotsTemplate' | 'quickbooksSalesDetail' | 'genericTable' | 'unknown';
  confidence: number;
}

export interface ParseResult {
  transactions: NormalizedTransaction[];
  metadata: ImportMetadata;
  warnings: string[];
  errors: string[];
}

export interface CustomerV5 {
  id: string;
  name: string;
  aliases: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductV5 {
  id: string;
  name: string;
  brand: string;
  packSize: number;
  packUom: string;
  active: boolean;
}

export interface OrderV5 {
  id: string;
  docNumber: string;
  docType: string;
  docDate: string;
  customerId: string;
  customerNameRaw: string;
  subtotal: number;
  total: number;
  status: string;
  importBatchId: string;
  hashKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderLineV5 {
  id: string;
  orderId: string;
  productNameRaw: string;
  productNameNormalized?: string;
  memo: string;
  qty: number;
  uom?: string;
  unitPrice: number;
  amount: number;
  packCount?: number;
  packSize?: number;
  packUom?: string;
  packType?: string;
  derivedKg?: number;
  sortIndex: number;
  createdAt: string;
}

export interface ImportBatchV5 {
  id: string;
  fileName: string;
  sheetName: string;
  formatDetected: string;
  confidence: number;
  rowCountRaw: number;
  ordersCreated: number;
  linesCreated: number;
  warnings: string[];
  createdAt: string;
}
