/** Contract 04's private receipt spelling is deliberately distinct from domain fields. */
export interface ProcessStamp {
  pid: number;
  proc_start: string;
  boot_id: string;
  pid_domain: string;
}
