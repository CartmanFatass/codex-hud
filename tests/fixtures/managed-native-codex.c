/* SIMULATED ELF Codex 0.166.0. No provider, accounts, or vendor executable.
 * Owns a direct Node child and retains its PID until the child exits. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifndef SIMULATED_VERSION
#define SIMULATED_VERSION "0.166.0"
#endif
extern char **environ;
static volatile sig_atomic_t owned_child = -1;
static void stop_owned(int signal_number) { (void)signal_number; if (owned_child > 0) kill((pid_t)owned_child, SIGTERM); }
static void probe_receipt(void) {
  const char *path = getenv("SYNTHETIC_NATIVE_PROBE_LOG");
  if (!path) return;
  FILE *stat = fopen("/proc/self/stat", "r");
  char buffer[4096], start[64] = "";
  if (!stat || !fgets(buffer, sizeof(buffer), stat)) { if (stat) fclose(stat); return; }
  fclose(stat);
  char *at = strrchr(buffer, ')');
  if (!at) return;
  char *save = NULL, *word = strtok_r(at + 2, " ", &save);
  for (int i = 0; word && i < 19; i++) word = strtok_r(NULL, " ", &save);
  if (!word || strlen(word) >= sizeof(start)) return;
  strcpy(start, word);
  struct timespec now; clock_gettime(CLOCK_REALTIME, &now);
  long long ms = (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
  FILE *out = fopen(path, "a");
  if (!out) return;
  fprintf(out, "{\"pid\":%ld,\"procStart\":\"%s\",\"observedAt\":%lld,\"deadlineAt\":%lld,\"version\":\"%s\"}\n", (long)getpid(), start, ms, ms+1000, SIMULATED_VERSION);
  fclose(out);
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    for (char **p = environ; *p; p++)
      if (strncmp(*p,"HUD_",4)==0 || strncmp(*p,"PI_SESSION_",11)==0 || strncmp(*p,"PI_CODING_AGENT_SESSION_DIR=",sizeof("PI_CODING_AGENT_SESSION_DIR=")-1)==0) return 93;
    probe_receipt();
    puts("codex-cli " SIMULATED_VERSION " (SIMULATED native fixture)"); return 0;
  }
  const char *node = getenv("SYNTHETIC_NATIVE_NODE");
  const char *driver = getenv("SYNTHETIC_NATIVE_DRIVER");
  if (!node || *node != '/' || !driver || *driver != '/') return 125;
  alarm(55);
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    alarm(50);
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!args) _exit(125);
    args[0] = (char *)node; args[1] = (char *)driver;
    for (int i = 1; i < argc; i++) args[i+1] = argv[i];
    execv(node,args); _exit(127);
  }
  owned_child = child;
  signal(SIGTERM, stop_owned); signal(SIGALRM, stop_owned);
  int status;
  while(waitpid(child,&status,0)<0) if(errno!=EINTR) return 125;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128+WTERMSIG(status);
}
