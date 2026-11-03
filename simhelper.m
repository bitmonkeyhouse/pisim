// simhelper: the native side of pisim, one command per job.
//
// simhelper hid <udid>
//   Keeps one HID connection open to the simulator's dtuhidd (Xcode 27+) and sends touches and keys
//   read from stdin, one command per line:
//     down <x> <y> | move <x> <y> | up <x> <y>   touch, x/y as fractions of the screen from top-left
//     key <usage> down|up                         USB HID keyboard usage code
//     button <page> <usage> down|up              hardware button, as a HID usage page and code
//     orientation <1-4>                           rotate the device: portrait, upside down, landscape
//                                                 with its top on the left (3) or on the right (4)
//   Touch coordinates are in the display buffer, which stays portrait when the device rotates.
//   Prints "ready" once dtuhidd has answered. Each separate connection pays ~0.5s for dtuhidd to
//   activate; this pays it once.
//
// simhelper video <udid> [<terminal pid>...]
//   Streams the main display as raw RGBA frames, only when it changes. stdin, one command per line:
//     rotate <0-3>   turn frames clockwise by that many quarter turns, to match a rotated device
//                    (the display buffer stays portrait); nothing is sent until the next size
//     size <w> <h>   deliver frames scaled to w x h pixels, after any rotation (nothing is sent until
//                    this arrives)
//     next           the reader is ready for another frame
//   stdout:
//     source <w> <h>         the display buffer's size in pixels, at start and whenever it changes
//     frame <w> <h> <path>   a w x h RGBA file; the reader (the terminal, via Kitty's t=t) deletes it
//     ppi <n>                pixels per inch of the display showing the terminal (the frontmost
//                            window of the given apps), at start and whenever it changes
//   At most one frame is in flight: after "frame", nothing more is sent until "next". The GPU scales
//   the display surface (wrapped as a Metal texture, no copy) into an RGBA texture; the CPU only
//   reads that back, and turns it if the device is rotated.
//
// simhelper describe <udid>
//   Prints the frontmost app's accessibility tree as JSON: an array holding the app element, each
//   element { type, AXLabel, AXUniqueId, AXValue, enabled, frame {x, y, width, height}, children },
//   frames in points from the top-left (the shape `axe describe-ui` prints). Read on the Mac through
//   the private AccessibilityPlatformTranslation framework, as Simulator.app does, with each request
//   sent through CoreSimulator; one round trip per element.
//
// simhelper bezel-size <pdf>
//   Prints a DeviceKit bezel PDF's page size in points, "<w> <h>".
//
// simhelper bezel <pdf> <mask.png> <out.png> <w> <h> <canvasW> <canvasH> <padLeft> <padTop> <holeX> <holeY> <holeW> <holeH> <rrggbb> <quarter>
//   Draws the bezel at w x h on a transparent canvasW x canvasH canvas at padLeft,padTop, turned
//   clockwise by `quarter` quarter turns, with the screen cut out of the hole rect in the shape of
//   mask.png's alpha (a masked screenshot), so frames drawn underneath show through. Frames have
//   square corners whose tips stick out past the bezel's rounded outline, so the hole's corners are
//   filled with the terminal background. Positions are in pixels from the top-left, after turning.
//
// The HID connection and wire format, finding and following the display, and reading accessibility
// follow Meta's idb (MIT licence): FBSimulatorControl/HID, FBSimulatorControl/XPC,
// FBSimulatorControl/Framebuffer and FBSimulatorAX.
//
// Build: clang -fobjc-arc -framework Foundation -framework IOSurface -framework Metal -framework MetalPerformanceShaders -framework CoreGraphics -framework ImageIO -framework Accelerate simhelper.m -o simhelper
#import <Accelerate/Accelerate.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <ImageIO/ImageIO.h>
#import <Metal/Metal.h>
#import <MetalPerformanceShaders/MetalPerformanceShaders.h>
#import <dlfcn.h>
#import <xpc/xpc.h>

// The private CoreSimulator / CoreSimDeviceIO methods used; the IO objects are remote proxies.
@interface NSObject (CoreSimulator)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSDictionary *)devicesByUDID;
- (unsigned int)lookup:(NSString *)service error:(NSError **)error;
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (unsigned short)displayClass;
- (id)framebufferSurface;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid
                          callbackQueue:(dispatch_queue_t)queue
                          frameCallback:(void (^)(void))frame
                surfacesChangedCallback:(void (^)(id, id))surfaces
              propertiesChangedCallback:(void (^)(id))properties;
// SimDevice, and AccessibilityPlatformTranslation's AXPTranslator, AXPTranslatorRequest and AXPMacPlatformElement.
- (void)sendAccessibilityRequestAsync:(id)request completionQueue:(dispatch_queue_t)queue completionHandler:(void (^)(id))handler;
+ (id)sharedInstance;
- (void)setSupportsDelegateTokens:(BOOL)supports;
- (void)setAccessibilityEnabled:(BOOL)enabled;
- (void)setBridgeTokenDelegate:(id)delegate;
- (id)frontmostApplicationWithDisplayId:(unsigned int)display bridgeDelegateToken:(NSString *)token;
- (id)macPlatformElementFromTranslation:(id)translation;
- (void)setBridgeDelegateToken:(NSString *)token;
- (id)translation;
- (void)setClientType:(unsigned long long)type;
- (NSString *)accessibilityRole;
- (NSString *)accessibilityLabel;
- (NSString *)accessibilityIdentifier;
- (id)accessibilityValue;
- (CGRect)accessibilityFrame;
- (BOOL)isAccessibilityEnabled;
- (NSArray *)accessibilityChildren;
@end

static void fail(NSString *msg) {
	fprintf(stderr, "simhelper: %s\n", msg.UTF8String);
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
	id d = [[[context defaultDeviceSetWithError:&err] devicesByUDID] objectForKey:[[NSUUID alloc] initWithUUIDString:udid]];
	if (!d) fail([NSString stringWithFormat:@"no simulator %@ (%@)", udid, err.localizedDescription ?: @"not found"]);
	return d;
}

// MARK: - hid

static NSString *const Service = @"com.apple.coredevice.feature.remote.hid.digitizer";

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

// Rotates the device: a GSEvent "device orientation changed" mach message to SpringBoard's
// PurpleWorkspacePort, laid out as idb's SimulatorPurpleHID builds it. (idb uses a vendor HID event
// instead on runtimes that report device motion; none of the iPhone runtimes tested here do, and the
// Purple message works on them.)
static void sendOrientation(id dev, uint32_t orientation) {
	NSError *err;
	mach_port_t port = [dev lookup:@"PurpleWorkspacePort" error:&err];
	if (!port) {
		fprintf(stderr, "simhelper: no PurpleWorkspacePort: %s\n", err.localizedDescription.UTF8String);
		return;
	}
	uint32_t msg[28] = { 0 };                     // 112 bytes; the mach message is the first 108
	msg[0] = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0); // header: bits, size, remote port, local port, voucher, id
	msg[1] = 108;
	msg[2] = port;
	msg[5] = 0x7B;
	msg[0x18 / 4] = 50 | 0x20000; // GSEventTypeDeviceOrientationChanged | host flag
	msg[0x48 / 4] = 4;            // record info size
	msg[0x4C / 4] = orientation;
	kern_return_t kr = mach_msg((mach_msg_header_t *)msg, MACH_SEND_MSG | MACH_SEND_TIMEOUT, 108, 0, MACH_PORT_NULL, 2000, MACH_PORT_NULL);
	if (kr != KERN_SUCCESS) fprintf(stderr, "simhelper: orientation not sent: %s\n", mach_error_string(kr));
}

static void runHid(NSString *udid) {
	id dev = device(udid);
	xpc_connection_t conn = connectTo(dev, Service);
	xpc_connection_set_target_queue(conn, dispatch_queue_create("simhelper.hid", DISPATCH_QUEUE_SERIAL));
	xpc_connection_set_event_handler(conn, ^(xpc_object_t e) {
		// Interrupted: XPC reconnects on the next send, but a touch in progress is lost. Invalid: give up.
		if (e == XPC_ERROR_CONNECTION_INVALID) fail(@"dtuhidd connection invalidated");
		if (e == XPC_ERROR_CONNECTION_INTERRUPTED) fprintf(stderr, "simhelper: dtuhidd connection interrupted\n");
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
		unsigned long long usage, page;
		if (sscanf(line, "%7s %lf %lf", cmd, &x, &y) == 3 && (!strcmp(cmd, "down") || !strcmp(cmd, "move") || !strcmp(cmd, "up"))) {
			uint64_t type = !strcmp(cmd, "up") ? 2 : touching ? 1 : 0; // a down while touching continues the contact
			touching = type != 2;
			xpc_connection_send_message(conn, touchEvent(x, y, type));
		} else if (sscanf(line, "key %llu %7s", &usage, state) == 2) {
			xpc_connection_send_message(conn, message("IndigoKeyboardButtonEvent", false, keyPayload(usage, !strcmp(state, "down"))));
		} else if (sscanf(line, "button %llu %llu %7s", &page, &usage, state) == 3) {
			xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
			xpc_dictionary_set_uint64(p, "usagePage", page);
			xpc_dictionary_set_uint64(p, "usageCode", usage);
			xpc_dictionary_set_uint64(p, "state", !strcmp(state, "down") ? 1 : 2);
			xpc_connection_send_message(conn, message("IndigoButtonEvent", false, p));
		} else if (sscanf(line, "orientation %llu", &usage) == 1 && usage >= 1 && usage <= 4) {
			sendOrientation(dev, (uint32_t)usage);
		} else {
			fprintf(stderr, "simhelper: ignoring %s", line);
		}
	}
	usleep(80000); // let the last events reach the guest before the connection goes (idb's drain)
}

// MARK: - video

// The main display's port descriptor: displayClass 0 (iOS's main screen).
static id mainDisplay(id dev) {
	for (id port in [[dev io] ioPorts]) {
		id d = [port descriptor];
		if (![d respondsToSelector:@selector(framebufferSurface)] || ![d respondsToSelector:NSSelectorFromString(@"state")]) continue;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks" // `state` by selector: the name clashes with Foundation's
		id state = [d performSelector:NSSelectorFromString(@"state")];
#pragma clang diagnostic pop
		if ([state respondsToSelector:@selector(displayClass)] && [state displayClass] == 0) return d;
	}
	fail(@"no main display (is the simulator booted?)");
	return nil;
}

// All state below is touched only on `work`.
static dispatch_queue_t work;
static IOSurfaceRef surface;
static size_t srcW, srcH, outW, outH; // out: the delivered size, after turning
static unsigned quarter;              // clockwise quarter turns to apply
static bool dirty = true, wanted = true;
static unsigned long frameNo;
static NSString *dir;
static id<MTLDevice> gpu;
static id<MTLCommandQueue> gpuQueue;
static MPSImageLanczosScale *scaler;
static id<MTLTexture> srcTex, outTex;
static void *pixels, *turned;

static void setSurface(IOSurfaceRef s) {
	if (surface) CFRelease(surface);
	surface = s ? (IOSurfaceRef)CFRetain(s) : NULL;
	srcTex = nil;
	dirty = true;
}

// Scales the current surface into an RGBA file and hands it over, if one is due.
static void deliver(void) {
	if (!surface || !dirty || !wanted) return;
	size_t w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface);
	if (w != srcW || h != srcH) { // new size: report it and wait for the reader to choose a scale
		srcW = w, srcH = h, outW = outH = 0;
		printf("source %zu %zu\n", w, h);
		return;
	}
	if (!outW) return;
	dirty = wanted = false;

	if (!srcTex) {
		MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];
		d.usage = MTLTextureUsageShaderRead;
		srcTex = [gpu newTextureWithDescriptor:d iosurface:surface plane:0];
	}
	id<MTLCommandBuffer> cmd = [gpuQueue commandBuffer];
	[scaler encodeToCommandBuffer:cmd sourceTexture:srcTex destinationTexture:outTex]; // BGRA in, RGBA out
	[cmd commit];
	[cmd waitUntilCompleted];
	size_t sw = quarter % 2 ? outH : outW, sh = quarter % 2 ? outW : outH; // the scaled size, before turning
	[outTex getBytes:pixels bytesPerRow:sw * 4 fromRegion:MTLRegionMake2D(0, 0, sw, sh) mipmapLevel:0];
	void *data = pixels;
	if (quarter) {
		const uint8_t clockwise[4] = { kRotate0DegreesClockwise, kRotate90DegreesClockwise, kRotate180DegreesClockwise, kRotate270DegreesClockwise };
		vImage_Buffer from = { pixels, sh, sw, sw * 4 }, to = { turned, outH, outW, outW * 4 };
		const uint8_t clear[4] = { 0 };
		vImageRotate90_ARGB8888(&from, &to, clockwise[quarter], clear, kvImageNoFlags);
		data = turned;
	}

	// Kitty's t=t: the terminal deletes the file once read, if it's in a temp dir and named like this.
	NSString *path = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"tty-graphics-protocol-%lu.rgba", frameNo++]];
	FILE *f = fopen(path.fileSystemRepresentation, "wb");
	if (!f || fwrite(data, 1, outW * outH * 4, f) != outW * outH * 4) fail(@"couldn't write a frame");
	fclose(f);
	printf("frame %zu %zu %s\n", outW, outH, path.UTF8String);
}

// w x h is the delivered size; the GPU scales to it before turning.
static void setSize(size_t w, size_t h) {
	outW = w, outH = h;
	size_t sw = quarter % 2 ? h : w, sh = quarter % 2 ? w : h;
	MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:sw height:sh mipmapped:NO];
	d.usage = MTLTextureUsageShaderWrite;
	d.storageMode = MTLStorageModeShared;
	outTex = [gpu newTextureWithDescriptor:d];
	free(pixels);
	free(turned);
	pixels = malloc(w * h * 4);
	turned = malloc(w * h * 4);
	dirty = true;
}

// Pixels per inch of the display under the centre of the frontmost on-screen window owned by one of
// `pids` (the main display if there's none): backing pixels across over the physical width.
static double terminalPpi(NSArray<NSNumber *> *pids) {
	CGDirectDisplayID display = CGMainDisplayID();
	NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
	for (NSDictionary *w in windows) { // front to back
		if ([w[(id)kCGWindowLayer] intValue] != 0 || ![pids containsObject:w[(id)kCGWindowOwnerPID]]) continue;
		CGRect r;
		CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r);
		uint32_t n;
		CGGetDisplaysWithPoint(CGPointMake(CGRectGetMidX(r), CGRectGetMidY(r)), 1, &display, &n);
		break;
	}
	CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
	double px = mode ? CGDisplayModeGetPixelWidth(mode) : 0, mm = CGDisplayScreenSize(display).width;
	CGDisplayModeRelease(mode);
	return mm > 0 ? px / (mm / 25.4) : 0;
}

static void runVideo(NSString *udid, NSArray<NSNumber *> *terminalPids) {
	// Closing the pane hangs up everything in it; exit on end of input instead, which also comes
	// when the viewer goes, so the frame directory is cleaned up.
	signal(SIGHUP, SIG_IGN);
	signal(SIGINT, SIG_IGN);
	dir = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"pisim-video-%d", getpid()]];
	[NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
	work = dispatch_queue_create("simhelper.video", DISPATCH_QUEUE_SERIAL);
	gpu = MTLCreateSystemDefaultDevice();
	gpuQueue = [gpu newCommandQueue];
	scaler = [[MPSImageLanczosScale alloc] initWithDevice:gpu];

	id display = mainDisplay(device(udid));
	dispatch_sync(work, ^{ setSurface((__bridge IOSurfaceRef)[display framebufferSurface]); });
	// CoreSimulator waits for these callbacks to return, so they only flag work for `work`.
	dispatch_queue_t callbacks = dispatch_queue_create("simhelper.callbacks", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
	[display registerScreenCallbacksWithUUID:[NSUUID UUID]
		callbackQueue:callbacks
		frameCallback:^{
			dispatch_async(work, ^{
				dirty = true;
				deliver();
			});
		}
		surfacesChangedCallback:^(id framebuffer, id masked) {
			IOSurfaceRef s = (IOSurfaceRef)CFBridgingRetain(framebuffer);
			dispatch_async(work, ^{
				setSurface(s);
				if (s) CFRelease(s);
				deliver();
			});
		}
		propertiesChangedCallback:^(id properties){
		}];

	// Watch which display the terminal is on, so the viewer can keep the device at physical size.
	// Printed on `work`, like everything else on stdout, so lines don't interleave.
	__block double ppi = -1; // so the first reading is always printed, even 0 (unknown)
	dispatch_source_t watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, work);
	dispatch_source_set_timer(watch, DISPATCH_TIME_NOW, NSEC_PER_SEC, NSEC_PER_SEC / 4);
	dispatch_source_set_event_handler(watch, ^{
		double now = terminalPpi(terminalPids);
		if (fabs(now - ppi) < 1) return;
		ppi = now;
		printf("ppi %.1f\n", ppi);
	});
	dispatch_resume(watch);
	dispatch_async(work, ^{ deliver(); });

	char line[64];
	size_t w, h;
	while (fgets(line, sizeof line, stdin)) {
		unsigned q;
		if (sscanf(line, "size %zu %zu", &w, &h) == 2 && w && h) {
			dispatch_async(work, ^{
				setSize(w, h);
				deliver();
			});
		} else if (sscanf(line, "rotate %u", &q) == 1) {
			dispatch_async(work, ^{
				quarter = q % 4;
				outW = outH = 0; // wait for the size laid out for this orientation
			});
		} else if (!strncmp(line, "next", 4)) {
			dispatch_async(work, ^{
				wanted = true;
				deliver();
			});
		}
	}
	dispatch_sync(work, ^{ [NSFileManager.defaultManager removeItemAtPath:dir error:nil]; });
}

// MARK: - describe

// AXPTranslator asks its bridge delegate how to reach the simulator: each request goes through
// CoreSimulator to the accessibility service inside it, answered synchronously.
@interface AccessibilityBridge : NSObject
@property(strong) id device;
@end

@implementation AccessibilityBridge
- (id (^)(id))accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
	id dev = self.device;
	return ^id(id request) {
		[request setClientType:4]; // as XCTest: the full tree (buttons' icons and text, groups), not the flattened one
		__block id response;
		dispatch_semaphore_t done = dispatch_semaphore_create(0);
		[dev sendAccessibilityRequestAsync:request
			completionQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0)
			completionHandler:^(id r) {
				response = r;
				dispatch_semaphore_signal(done);
			}];
		dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
		return response;
	};
}
- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect withToken:(NSString *)token {
	return rect; // already in the simulator's points
}
- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
	return nil;
}
@end

static id describeElement(id el, NSString *token) {
	[[el translation] setBridgeDelegateToken:token];
	NSString *role = [el accessibilityRole];
	id value = [el accessibilityValue];
	CGRect f = [el accessibilityFrame];
	NSMutableArray *children = [NSMutableArray array];
	for (id child in [el accessibilityChildren]) [children addObject:describeElement(child, token)];
	return @{
		@"type" : [role hasPrefix:@"AX"] ? [role substringFromIndex:2] : role ?: @"",
		@"AXLabel" : [el accessibilityLabel] ?: NSNull.null,
		@"AXUniqueId" : [el accessibilityIdentifier] ?: NSNull.null,
		@"AXValue" : value ? [value description] : NSNull.null,
		@"enabled" : @([el isAccessibilityEnabled]),
		@"frame" : @{ @"x" : @(f.origin.x), @"y" : @(f.origin.y), @"width" : @(f.size.width), @"height" : @(f.size.height) },
		@"children" : children,
	};
}

static void describeScreen(NSString *udid) {
	if (!dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW)) {
		fail(@"can't load AccessibilityPlatformTranslation");
	}
	AccessibilityBridge *bridge = [AccessibilityBridge new]; // the translator holds its delegate weakly
	bridge.device = device(udid);
	id translator = [NSClassFromString(@"AXPTranslator") sharedInstance];
	[translator setSupportsDelegateTokens:YES];
	[translator setAccessibilityEnabled:YES];
	[translator setBridgeTokenDelegate:bridge];
	NSString *token = NSUUID.UUID.UUIDString;
	id app = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:token];
	if (!app) fail(@"no frontmost app (is the simulator booted?)");
	[app setBridgeDelegateToken:token];
	NSData *json = [NSJSONSerialization dataWithJSONObject:@[ describeElement([translator macPlatformElementFromTranslation:app], token) ] options:0 error:nil];
	fwrite(json.bytes, 1, json.length, stdout);
	printf("\n");
}

// MARK: - bezel

static CGPDFPageRef pdfPage(const char *path) {
	CGPDFDocumentRef doc = CGPDFDocumentCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(path)]);
	CGPDFPageRef p = doc ? CGPDFDocumentGetPage(doc, 1) : NULL; // the document is kept for the process's life
	if (!p) fail([NSString stringWithFormat:@"can't read %s", path]);
	return p;
}

// argv: <pdf> <mask.png> <out.png> <w> <h> <canvasW> <canvasH> <padLeft> <padTop> <holeX> <holeY> <holeW> <holeH> <rrggbb> <quarter>
static void renderBezel(char **argv) {
	double n[10];
	for (int i = 0; i < 10; i++) n[i] = atof(argv[3 + i]);
	double w = n[0], h = n[1], cw = n[2], ch = n[3], padLeft = n[4], padTop = n[5];
	unsigned rgb = (unsigned)strtoul(argv[13], NULL, 16);
	int q = atoi(argv[14]) % 4;
	// Core Graphics puts the origin at the bottom-left, so flip y.
	CGRect hole = CGRectMake(n[6], ch - n[7] - n[9], n[8], n[9]);

	CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
	CGContextRef ctx = CGBitmapContextCreate(NULL, (size_t)cw, (size_t)ch, 8, 0, srgb, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
	CGContextSetRGBFillColor(ctx, (rgb >> 16 & 255) / 255.0, (rgb >> 8 & 255) / 255.0, (rgb & 255) / 255.0, 1);
	CGContextFillRect(ctx, hole);

	// The PDF is drawn turned about the centre of its w x h box; before turning it is h x w for odd q.
	CGPDFPageRef p = pdfPage(argv[0]);
	CGRect box = CGPDFPageGetBoxRect(p, kCGPDFMediaBox);
	CGContextSaveGState(ctx);
	CGContextTranslateCTM(ctx, padLeft + w / 2, ch - padTop - h / 2);
	CGContextRotateCTM(ctx, -q * M_PI_2); // negative is clockwise with y up
	CGContextScaleCTM(ctx, (q % 2 ? h : w) / box.size.width, (q % 2 ? w : h) / box.size.height);
	CGContextTranslateCTM(ctx, -box.origin.x - box.size.width / 2, -box.origin.y - box.size.height / 2);
	CGContextDrawPDFPage(ctx, p);
	CGContextRestoreGState(ctx);

	CGImageSourceRef maskSrc = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[1])], NULL);
	CGImageRef mask = maskSrc ? CGImageSourceCreateImageAtIndex(maskSrc, 0, NULL) : NULL;
	if (!mask) fail([NSString stringWithFormat:@"can't read %s", argv[1]]);
	CGContextSetBlendMode(ctx, kCGBlendModeDestinationOut); // erase where the screen is opaque
	// The screenshot may or may not be turned yet; its corners are symmetric, so lay it along the hole.
	bool maskWide = CGImageGetWidth(mask) > CGImageGetHeight(mask), holeWide = hole.size.width > hole.size.height;
	CGContextTranslateCTM(ctx, CGRectGetMidX(hole), CGRectGetMidY(hole));
	if (maskWide != holeWide) CGContextRotateCTM(ctx, M_PI_2);
	double mw = maskWide != holeWide ? hole.size.height : hole.size.width, mh = maskWide != holeWide ? hole.size.width : hole.size.height;
	CGContextDrawImage(ctx, CGRectMake(-mw / 2, -mh / 2, mw, mh), mask);

	CGImageRef out = CGBitmapContextCreateImage(ctx);
	CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[2])], CFSTR("public.png"), 1, NULL);
	if (!dest) fail([NSString stringWithFormat:@"can't write %s", argv[2]]);
	CGImageDestinationAddImage(dest, out, NULL);
	if (!CGImageDestinationFinalize(dest)) fail([NSString stringWithFormat:@"can't write %s", argv[2]]);
}

int main(int argc, char **argv) {
	@autoreleasepool {
		setvbuf(stdout, NULL, _IOLBF, 0);
		const char *cmd = argc > 1 ? argv[1] : "";
		if (argc == 3 && !strcmp(cmd, "hid")) runHid(@(argv[2]));
		else if (argc >= 3 && !strcmp(cmd, "video")) {
			NSMutableArray *pids = [NSMutableArray array];
			for (int i = 3; i < argc; i++) [pids addObject:@(atoi(argv[i]))];
			runVideo(@(argv[2]), pids);
		}
		else if (argc == 3 && !strcmp(cmd, "describe")) describeScreen(@(argv[2]));
		else if (argc == 3 && !strcmp(cmd, "bezel-size")) {
			CGRect box = CGPDFPageGetBoxRect(pdfPage(argv[2]), kCGPDFMediaBox);
			printf("%.0f %.0f\n", box.size.width, box.size.height);
		} else if (argc == 17 && !strcmp(cmd, "bezel")) renderBezel(argv + 2);
		else fail(@"usage: simhelper hid <udid> | video <udid> | describe <udid> | bezel-size <pdf> | bezel <pdf> <mask.png> <out.png> <w> <h> <canvasW> <canvasH> <padLeft> <padTop> <holeX> <holeY> <holeW> <holeH> <rrggbb> <quarter>");
	}
	return 0;
}
