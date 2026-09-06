// I11 排期看板前端类型
export interface WorkCenter {
  key: string;
  name: string;
  machines: number;
  sortOrder: number;
}

export interface ProcessInfo {
  id: number;
  key: string;
  name: string;
  wcKey: string;
  sortOrder: number;
}

export interface PackagingSpec {
  box?: boolean;
  bag?: boolean;
  carton?: boolean;
  label?: boolean;
  [k: string]: boolean | string | undefined;
}

export interface SchedTask {
  lineId: number;
  planId: number;
  planNo: string;
  planStatus: string;
  orderId: number;
  orderNo: string;
  customerId: number;
  customerName: string;
  orderLineId: number;
  productId: number;
  productName: string;
  quantity: number;
  completed: number;
  progress: number;
  wcKey: string | null;
  wcName: string | null;
  startDate: string | null;
  coverDays: number | null;
  autoDays: number;
  durDays: number;
  unitSeconds: number | null;
  scheduled: boolean;
  dueDate: string | null;
  endDate: string | null;
  overdue: boolean;
  engraving?: string | null;
  packaging?: PackagingSpec | null;
  // 工序推进（I06 整批逐道；无路由产品 routeTotal=0 成品直报）
  routeSeq: number;
  routeTotal: number;
  stepIdx: number; // 当前工序序号（1-based；0=无路由）
  currentStepName: string | null; // 当前工序名
}

export interface VerifyResult {
  unitSeconds: number | null;
  machines: number;
  autoDays: number;
  coverDays: number;
  durationHint: string;
  startDate: string;
  endDate: string;
  dueDate: string | null;
  overdue: boolean;
  laneLoad: number;
  wcName: string;
}