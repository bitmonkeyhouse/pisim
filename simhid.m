// simhid: keeps one HID connection open to a booted simulator's dtuhidd (Xcode 27+) and sends
// touches and keys read from stdin, one command per line:
//   down <x> <y> | move <x> <y> | up <x> <y>   touch, x/y as fractions of the screen from top-left
//   key <usage> down|up                         USB HID keyboard usage code
// Prints "ready" once dtuhidd has answered. Each separate connection pays ~0.5s for dtuhidd to
// activate; this pays it once.
//
// The connection and wire format follow Meta's idb (MIT licence), FBSimulatorControl/HID and
// FBSimulatorControl/XPC: SimulatorXPCConnection, SimulatorDTUHIDConnection, DTUHIDModels.
//
// Build: clang -fobjc-arc -framework Foundation simhid.m -o simhid
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <xpc/xpc.h>

static NSString *const Service = @"com.apple.coredevice.feature.remote.hid.digitizer";

// The private CoreSimulator methods used (SimServiceContext, SimDeviceSet, SimDevice).
@interface NSObject (CoreSimulator)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSDictionary *)devicesByUDID;
- (unsigned int)lookup:(NSString *)service error:(NSError **)error;
@end

static void fail(NSString *msg) {
	fprintf(stderr, "simhid: %s\n", msg.UTF8String);
	exit(1);
}

// The SimDevice for udid, via CoreSimulator's (private) service context.
static id device(NSString *udid) {
	if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) fail(@"can't load CoreSimulator");
	NSTask *task = [NSTask new];
	task.launchPath = @"/usr/bin/xcode-select";
	task.arguments = @[ @"-p" ];
	NSPipe *pipe = [NSPipe pipe];
	task.standardOutput = pipe;
	[task launch];
	[task waitUntilExit];
	NSString *dev = [[[NSString alloc] initWithData:pipe.fileHandleForReading.readDataToEndOfFile encoding:NSUTF8StringEncoding]
		stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
	NSError *err;
	id context = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:dev error:&err];
	id set = [context defaultDeviceSetWithError:&err];
	id d = [[set devicesByUDID] objectForKey:[[NSUUID alloc] initWithUUIDString:udid]];
	if (!d) fail([NSString stringWithFormat:@"no simulator %@ (%@)", udid, err.localizedDescription ?: @"not found"]);
	return d;
}

// Host connection to a service inside the simulator: look up its Mach port in the simulator's
// bootstrap namespace, wrap it with the private _4sim endpoint call, and mark it sim-to-host
// (without that the service sees the peer but never a payload).
static xpc_connection_t connectTo(id dev, NSString *service) {
	typedef xpc_object_t (*EndpointFromPort)(mach_port_t, uint64_t, uint64_t);
	typedef xpc_connection_t (*FromEndpoint)(xpc_object_t);
	typedef void (*Sim2Host)(xpc_connection_t);
	EndpointFromPort endpointFromPort = (EndpointFromPort)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
	FromEndpoint fromEndpoint = (FromEndpoint)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
	Sim2Host sim2host = (Sim2Host)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
	if (!endpointFromPort || !fromEndpoint || !sim2host) fail(@"private XPC symbols unavailable");
	NSError *err;
	unsigned int port = [dev lookup:service error:&err];
	if (!port) fail([NSString stringWithFormat:@"lookup %@ failed: %@ (is the simulator booted?)", service, err.localizedDescription]);
	xpc_object_t endpoint = endpointFromPort(port, 0, 0);
	xpc_connection_t conn = endpoint ? fromEndpoint(endpoint) : NULL;
	if (!conn) fail(@"couldn't create the XPC connection");
	sim2host(conn);
	return conn;
}

// Every dtuhidd message is { messageType, isBarrier, featureIdentifier, payload }.
static xpc_object_t message(const char *type, bool barrier, xpc_object_t payload) {
	xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
	xpc_dictionary_set_string(m, "messageType", type);
	xpc_dictionary_set_bool(m, "isBarrier", barrier);
	xpc_dictionary_set_string(m, "featureIdentifier", Service.UTF8String);
	xpc_dictionary_set_value(m, "payload", payload);
	return m;
}

// Key states are 1-based: down = 1, up = 2.
static xpc_object_t keyPayload(uint64_t usage, bool down) {
	xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
	xpc_dictionary_set_uint64(p, "usageCode", usage);
	xpc_dictionary_set_uint64(p, "state", down ? 1 : 2);
	return p;
}

// eventType: start = 0, position = 1, end = 2.
static xpc_object_t touchEvent(double x, double y, uint64_t type) {
	xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
	xpc_dictionary_set_double(point, "x", x);
	xpc_dictionary_set_double(point, "y", y);
	xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
	xpc_dictionary_set_value(p, "pointOne", point);
	xpc_dictionary_set_uint64(p, "eventType", type);
	xpc_dictionary_set_uint64(p, "edge", 0);
	xpc_dictionary_set_uint64(p, "target", 0);
	return message("IndigoDigitizerEvent", false, p);
}

int main(int argc, char **argv) {
	@autoreleasepool {
		if (argc != 2) fail(@"usage: simhid <udid>");
		setvbuf(stdout, NULL, _IOLBF, 0);
		xpc_connection_t conn = connectTo(device(@(argv[1])), Service);
		xpc_connection_set_target_queue(conn, dispatch_queue_create("simhid", DISPATCH_QUEUE_SERIAL));
		xpc_connection_set_event_handler(conn, ^(xpc_object_t e) {
			// Interrupted: XPC reconnects on the next send, but a touch in progress is lost. Invalid: give up.
			if (e == XPC_ERROR_CONNECTION_INVALID) fail(@"dtuhidd connection invalidated");
			if (e == XPC_ERROR_CONNECTION_INTERRUPTED) fprintf(stderr, "simhid: dtuhidd connection interrupted\n");
		});
		xpc_connection_resume(conn);

		// A key-up of usage 0 ("no event") as a barrier: dtuhidd replies once it's active, and nothing
		// sent before that would arrive. Then idb's 200ms for the device to open.
		dispatch_semaphore_t answered = dispatch_semaphore_create(0);
		xpc_connection_send_message_with_reply(conn, message("IndigoKeyboardButtonEvent", true, keyPayload(0, false)),
			dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(xpc_object_t reply) {
				if (xpc_get_type(reply) == XPC_TYPE_ERROR) fail(@"dtuhidd didn't answer");
				dispatch_semaphore_signal(answered);
			});
		if (dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC))) fail(@"dtuhidd didn't answer within 4s");
		usleep(200000);
		printf("ready\n");

		char line[256];
		bool touching = false;
		while (fgets(line, sizeof line, stdin)) {
			char cmd[8], state[8];
			double x, y;
			unsigned long long usage;
			if (sscanf(line, "%7s %lf %lf", cmd, &x, &y) == 3 && (!strcmp(cmd, "down") || !strcmp(cmd, "move") || !strcmp(cmd, "up"))) {
				uint64_t type = !strcmp(cmd, "up") ? 2 : touching ? 1 : 0; // a down while touching continues the contact
				touching = type != 2;
				xpc_connection_send_message(conn, touchEvent(x, y, type));
			} else if (sscanf(line, "key %llu %7s", &usage, state) == 2) {
				xpc_connection_send_message(conn, message("IndigoKeyboardButtonEvent", false, keyPayload(usage, !strcmp(state, "down"))));
			} else {
				fprintf(stderr, "simhid: ignoring %s", line);
			}
		}
		usleep(80000); // let the last events reach the guest before the connection goes (idb's drain)
	}
	return 0;
}
