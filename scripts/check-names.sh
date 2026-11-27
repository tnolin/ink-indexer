#!/usr/bin/env bash
# Fails when a tracked file has a line matching GUARD_PATTERN, after text
# matching GUARD_ALLOW has been blanked out. Both are Perl regular expressions
# read from the environment, so they never appear in a command line or in
# output. Only `path:line` is printed for a hit.
set -euo pipefail

pattern="${GUARD_PATTERN-}"
allow="${GUARD_ALLOW-}"
pattern="${pattern//$'\r'/}"
pattern="${pattern//$'\n'/}"
allow="${allow//$'\r'/}"
allow="${allow//$'\n'/}"

if [ -z "$pattern" ]; then
  if [ "${GUARD_FORK-}" = "true" ]; then
    echo "guard skipped: no patterns (pull request from a fork)" >&2
    exit 0
  fi
  echo "guard: GUARD_PATTERN is empty" >&2
  exit 1
fi

export GUARD_PATTERN="$pattern"
export GUARD_ALLOW="$allow"

git ls-files -z | perl -e '
  local $SIG{__WARN__} = sub {};
  my $re = eval { qr/$ENV{GUARD_PATTERN}/i };
  my $allow;
  if (length $ENV{GUARD_ALLOW}) {
    $allow = eval { qr/$ENV{GUARD_ALLOW}/i };
  }
  if (!defined $re || (length $ENV{GUARD_ALLOW} && !defined $allow)) {
    print STDERR "guard: a pattern does not compile\n";
    exit 2;
  }
  my %skip_names = map { $_ => 1 } qw(pnpm-lock.yaml pnpm-workspace.yaml);
  my %skip_ext = map { $_ => 1 } qw(png jpg jpeg gif svg webp ico);
  local $/ = "\0";
  my @files = <STDIN>;
  chomp @files;
  my $hits = 0;
  for my $file (@files) {
    my ($base) = $file =~ m{([^/]*)\z};
    next if $skip_names{$base};
    my ($ext) = $base =~ m{\.([^.]*)\z};
    next if defined $ext && $skip_ext{lc $ext};
    next unless -f $file;
    open(my $fh, "<:raw", $file) or next;
    local $/ = "\n";
    while (my $line = <$fh>) {
      $line =~ s/$allow/ /g if defined $allow;
      if ($line =~ $re) {
        print "$file:$.\n";
        $hits++;
      }
    }
    close $fh;
  }
  exit($hits ? 1 : 0);
'
