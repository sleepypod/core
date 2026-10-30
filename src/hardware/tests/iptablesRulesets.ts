/** `iptables -S <chain>` listings for the firewall check tests, keyed by chain. */
export type Ruleset = Record<string, string>

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

/** scripts/install block_wan (and scripts/lib/iptables-helpers). */
export const INSTALL_BLOCK_WAN = {
  INPUT: lines(
    '-P INPUT DROP',
    ...['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'].map(cidr => `-A INPUT -s ${cidr} -p tcp -m tcp --dport 51827 -j ACCEPT`),
    '-A INPUT -p udp -m udp --sport 5353 -j ACCEPT',
    '-A INPUT -p udp -m udp --dport 5353 -j ACCEPT',
    '-A INPUT -p udp -m udp --sport 123 -j ACCEPT',
    '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A INPUT -s 10.0.0.0/8 -j ACCEPT',
    '-A INPUT -s 172.16.0.0/12 -j ACCEPT',
    '-A INPUT -s 192.168.0.0/16 -j ACCEPT',
    '-A INPUT -i lo -j ACCEPT',
    '-A INPUT -j DROP',
  ),
  OUTPUT: lines(
    '-P OUTPUT DROP',
    '-A OUTPUT -p udp -m udp --sport 5353 -j ACCEPT',
    '-A OUTPUT -p udp -m udp --dport 5353 -j ACCEPT',
    '-A OUTPUT -p udp -m udp --dport 123 -j ACCEPT',
    '-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A OUTPUT -d 10.0.0.0/8 -j ACCEPT',
    '-A OUTPUT -d 172.16.0.0/12 -j ACCEPT',
    '-A OUTPUT -d 192.168.0.0/16 -j ACCEPT',
    '-A OUTPUT -o lo -j ACCEPT',
    '-A OUTPUT -j DROP',
  ),
} satisfies Ruleset

/** src/server/routers/system.ts blockWan: default ACCEPT policies, terminal DROPs. */
export const APP_BLOCK_WAN = {
  INPUT: lines(
    '-P INPUT ACCEPT',
    '-A INPUT -d 224.0.0.251/32 -p udp -m udp --dport 5353 -j ACCEPT',
    '-A INPUT -p udp -m udp --sport 123 -j ACCEPT',
    '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A INPUT -s 10.0.0.0/8 -j ACCEPT',
    '-A INPUT -s 172.16.0.0/12 -j ACCEPT',
    '-A INPUT -s 192.168.0.0/16 -j ACCEPT',
    '-A INPUT -i lo -j ACCEPT',
    '-A INPUT -j DROP',
  ),
  OUTPUT: lines(
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -d 224.0.0.251/32 -p udp -m udp --sport 5353 -j ACCEPT',
    '-A OUTPUT -d 224.0.0.251/32 -p udp -m udp --dport 5353 -j ACCEPT',
    '-A OUTPUT -p udp -m udp --dport 123 -j ACCEPT',
    '-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A OUTPUT -d 10.0.0.0/8 -j ACCEPT',
    '-A OUTPUT -d 172.16.0.0/12 -j ACCEPT',
    '-A OUTPUT -d 192.168.0.0/16 -j ACCEPT',
    '-A OUTPUT -o lo -j ACCEPT',
    '-A OUTPUT -j DROP',
  ),
} satisfies Ruleset

/** scripts/internet-control block: OUTPUT only jumps; the allows and DROP live in SLEEPYPOD-BLOCK. */
export const INTERNET_CONTROL_BLOCK = {
  'INPUT': lines('-P INPUT ACCEPT'),
  'OUTPUT': lines('-P OUTPUT ACCEPT', '-A OUTPUT -j SLEEPYPOD-BLOCK'),
  'SLEEPYPOD-BLOCK': lines(
    '-N SLEEPYPOD-BLOCK',
    '-A SLEEPYPOD-BLOCK -o lo -j ACCEPT',
    '-A SLEEPYPOD-BLOCK -m state --state RELATED,ESTABLISHED -j ACCEPT',
    '-A SLEEPYPOD-BLOCK -d 192.168.1.0/24 -j ACCEPT',
    '-A SLEEPYPOD-BLOCK -d 224.0.0.251/32 -p udp -m udp --dport 5353 -j ACCEPT',
    '-A SLEEPYPOD-BLOCK -d 224.0.0.251/32 -p udp -m udp --sport 5353 -j ACCEPT',
    '-A SLEEPYPOD-BLOCK -p udp -m udp --dport 123 -j ACCEPT',
    '-A SLEEPYPOD-BLOCK -j DROP',
  ),
} satisfies Ruleset

/** Internet access allowed: every rule flushed, policy ACCEPT. */
export const FLUSHED = {
  INPUT: lines('-P INPUT ACCEPT'),
  OUTPUT: lines('-P OUTPUT ACCEPT'),
} satisfies Ruleset

/** Policy DROP with no rules at all: blocks, but every allow is missing. */
export const DROP_ONLY = {
  INPUT: lines('-P INPUT DROP'),
  OUTPUT: lines('-P OUTPUT DROP'),
} satisfies Ruleset

/** The listing a ruleset serves for a chain, or '' when it has none. */
export function pick(ruleset: Ruleset, chain: string | undefined): string {
  return ruleset[chain ?? ''] ?? ''
}

/** Which chain an `iptables -S <chain>` (or `-L <chain>`) command asks for. */
export function chainOf(args: string): string | undefined {
  return args.match(/ -[SL] (\S+)/)?.[1]
}
